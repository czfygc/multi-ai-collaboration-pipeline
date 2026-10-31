#!/usr/bin/env node
// orchestrator/model-catalog-sync.mjs — T-179 freellmapi 免费模型目录免维护 CLI
// 用法:
//   node orchestrator/model-catalog-sync.mjs --check            # 只读：打印剔除/分类计划（默认）
//   node orchestrator/model-catalog-sync.mjs --check --probe    # 加占位探针（慢，会打网关）
//   node orchestrator/model-catalog-sync.mjs --apply            # 落库（禁/恢）+ 入池 + 复检转正 + 审计账本 + 报告
//   node orchestrator/model-catalog-sync.mjs --apply --report <file.json>
// 选项: --db <path> --tiers <path> --gateway <url> --audit <path> --limit <n> --json
// 退出码: 0=无待处理, 1=有剔除/恢复动作, 2=用法错, 3=UNKNOWN（目录拉不到，判不了）
//
// 红线:
//   - 判不了的一律不剔除（下架无来源 / 探针超时 / 网络异常 → 标 UNKNOWN 不剔除）；
//   - 只动"我们自己禁的"行（审计账本），别人手工禁的保留；
//   - 密钥只走 env（FREELLMAPI_API_KEY），不进命令行、不进 URL。
// 实现：编排逻辑在 lib/catalog-runner.mjs（CLI 与定时调度共用同一份）。

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCatalogSync } from './lib/catalog-runner.mjs';
import { defaultPaths, TIERS } from './lib/free-catalog.mjs';
import { runChainHeadsSync } from './lib/chain-heads.mjs';
import { loadSecretsEnv } from './lib/alert.mjs';
import { readJsonFile, writeJsonAtomic, syncProviderFreeModels } from './lib/opencode-config.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const paths = defaultPaths(REPO_ROOT);

const apply = argv.includes('--apply');
const check = argv.includes('--check') || !apply;
const doProbe = argv.includes('--probe');
const asJson = argv.includes('--json');
const dbPath = resolve(flagValue('--db') || paths.db);
const tiersPath = resolve(flagValue('--tiers') || paths.tiers);
const auditPath = resolve(flagValue('--audit') || paths.audit);
const gatewayUrl = flagValue('--gateway') || process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001';
// T-251：网关 key 在启动处从 titan_secrets.env 装载（含 T-236 同类键名别名：仓内实为 TITAN_FREELLM_API_KEY）。
// 原第 44 行裸读 process.env → 独立跑/调度器跑都拿不到 key → 网关目录恒 401（scheduler 状态 gateway_ok:false 实证）。
{
  loadSecretsEnv({ repoRoot: REPO_ROOT, env: process.env, only: ['FREELLMAPI_API_KEY', 'TITAN_FREELLM_API_KEY'] });
  if (!process.env.FREELLMAPI_API_KEY && process.env.TITAN_FREELLM_API_KEY) {
    process.env.FREELLMAPI_API_KEY = process.env.TITAN_FREELLM_API_KEY;
  }
}
const apiKey = process.env.FREELLMAPI_API_KEY || '';
const reportPath = flagValue('--report');
const limit = Number(flagValue('--limit') || 0);
// OpenCode 配置同步（--sync-opencode <配置路径> --opencode-provider id1,id2）
const syncOpencode = flagValue('--sync-opencode');
const opencodeProviders = (flagValue('--opencode-provider') || 'openrouter')
  .split(',').map((s) => s.trim()).filter(Boolean);
// T-202 三条自带链目录同步（--sync-chains；apply 同开关：--apply 落盘，否则只读预览）
const syncChains = argv.includes('--sync-chains');

if (!existsSync(dbPath)) {
  console.error('[CATALOG] 找不到网关 DB: ' + dbPath + '（用 --db 指定）');
  process.exit(3);
}

const report = await runCatalogSync({
  repoRoot: REPO_ROOT, dbPath, tiersPath, auditPath,
  gatewayUrl, apiKey, apply, probe: doProbe, limit,
});

if (reportPath) {
  mkdirSync(dirname(resolve(reportPath)), { recursive: true });
  writeFileSync(resolve(reportPath), JSON.stringify(report, null, 2) + '\n', 'utf8');
}

// ── OpenCode 配置同步：免费模型清单 = 网关里**已验证可用**的那些（别的 AI 改回也会被纠正）──
let opencodeSync = null;
if (syncOpencode) {
  const cfgPath = resolve(syncOpencode);
  const cfg = readJsonFile(cfgPath);
  if (!cfg) {
    console.error('[CATALOG] 读不到 OpenCode 配置: ' + cfgPath);
    process.exit(2);
  }
  const knownGood = [];
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(report.db || dbPath, { readOnly: true });
    for (const r of db.prepare(`select model_id from models where platform='openrouter' and enabled=1 and model_id like '%:free'`).all()) {
      knownGood.push(r.model_id);
    }
    db.close();
  } catch (e) {
    console.error('[CATALOG] 读网关 DB 失败（拿不到已知可用清单）: ' + String(e.message || e).slice(0, 120));
  }
  const results = [];
  for (const pid of opencodeProviders) {
    const r = syncProviderFreeModels(cfg, pid, knownGood);
    results.push({ provider: pid, ...r });
  }
  opencodeSync = { config: cfgPath, known_good: knownGood.length, results };
  if (apply) writeJsonAtomic(cfgPath, cfg);
  report.opencodeSync = opencodeSync;
}

// ── T-202 三条自带链（auto:kilo / auto:titan-ofm / Anlyrouter）目录同步 ──
let chainSync = null;
if (syncChains) {
  // anly key 只走 env（titan_secrets.env 加载，不进命令行/日志）
  loadSecretsEnv({ repoRoot: REPO_ROOT, env: process.env, only: ['ANYROUTER_API_KEY'] });
  chainSync = await runChainHeadsSync({ repoRoot: REPO_ROOT, dbPath, apply });
  report.chainSync = chainSync;
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const t = report.totals || {};
  console.log('[CATALOG] DB=' + (report.db || dbPath));
  console.log('[CATALOG] 行数=' + (t.rows || 0) + ' | 保留=' + (t.keep || 0) + ' | 待禁=' + (t.disable || 0) +
    ' | 待恢=' + (t.enable || 0) + ' | 判不了=' + (t.unknown || 0) + ' | 新目录候选=' + (t.added_candidates || 0));
  console.log('[CATALOG] 档位分布: ' + TIERS.map((x) => x + '=' + ((t.tiers || {})[x] || 0)).join(' ') + ' | 策展: ' + (report.curated || ''));
  console.log('[CATALOG] 网关目录: ' + (report.gateway.ok ? report.gateway.models + ' 个模型' : '拉取失败（' + report.gateway.reason + '）'));
  console.log('[CATALOG] OpenRouter 目录: ' + (report.openrouter_catalog.ok ? report.openrouter_catalog.count + ' 个' : '拉取失败（' + report.openrouter_catalog.reason + '）→ 下架判不了，不剔除'));
  for (const d of report.disable || []) console.log('[CATALOG]   禁 ' + d.id + ' ' + d.platform + '/' + d.model_id + ' ← ' + d.reason);
  for (const e of report.enable || []) console.log('[CATALOG]   恢 ' + e.id + ' ' + e.platform + '/' + e.model_id + ' ← 免费身份');
  for (const u of report.unknown || []) console.log('[CATALOG]   未知 ' + u.modelId + ' ← ' + u.reason + '（不剔除）');
  const ins = (report.added_result && report.added_result.inserted) || [];
  for (const x of ins) console.log('[CATALOG]   入池 ' + x.platform + '/' + x.id + ' ← 档=' + x.tier + ' | 探针=' + x.probe + ' | ' + (x.enabled ? '启用' : '保持禁用（判不了/不可用）'));
  for (const p of (report.applied && report.applied.promoted) || []) console.log('[CATALOG]   转正 ' + p.id + ' ' + p.model_id + ' ← 探针可用');
  if (report.applied) console.log('[CATALOG] 已落库：禁 ' + report.applied.disabledCount + ' / 恢 ' + report.applied.enabledCount + '；审计账本 ' + report.applied.auditPath);
  if (opencodeSync) {
    console.log('[CATALOG] OpenCode 配置 ' + opencodeSync.config + '（已知可用免费模型 ' + opencodeSync.known_good + ' 个）');
    for (const r of opencodeSync.results) {
      console.log('[CATALOG]   ' + r.provider + '：新增 ' + r.added.length + ' / 移除 ' + r.removed.length +
        (r.removed.length ? ' → ' + r.removed.join(', ') : '') + (r.changed ? (apply ? '（已写回）' : '（--check 未写）') : '（无变化）'));
    }
  }
  if (chainSync) {
    const c = chainSync;
    const kilo = c.kilo || {};
    const ofm = c.ofm || {};
    const anly = c.anly || {};
    console.log('[CATALOG] 链同步: kilo=' + (kilo.reachable ? '可达' : '不可达(月度目录兜底)') +
      ' | ofm=' + (ofm.frozen ? '冻结(' + (ofm.reason || '').slice(0, 40) + ')' : '健康') +
      ' | anly=' + (anly.reachable ? '可达' : '不可达(no-op)'));
    if (kilo.head) console.log('[CATALOG]   kilo 链首 ' + kilo.head.length + ' 席: ' + kilo.head.join(' → '));
    if (kilo.added && kilo.added.length) console.log('[CATALOG]   kilo 新增: ' + kilo.added.join(', '));
    if (kilo.disabled && kilo.disabled.length) console.log('[CATALOG]   kilo 禁用(本机制行): ' + kilo.disabled.join(', '));
    if (kilo.ctxUpdates && kilo.ctxUpdates.length) for (const u of kilo.ctxUpdates) console.log('[CATALOG]   kilo 刷新 ' + u.id + ' ctx=' + u.ctx + ' tools=' + u.tools);
    if (ofm.frozen) console.log('[CATALOG]   ofm 链首冻结: ' + (ofm.reason || ''));
    if (ofm.head) console.log('[CATALOG]   ofm 链首 ' + ofm.head.length + ' 席: ' + ofm.head.join(' → '));
    if (ofm.dropped && ofm.dropped.length) console.log('[CATALOG]   ofm 出链首: ' + ofm.dropped.join(', '));
    if (ofm.addedDisabled && ofm.addedDisabled.length) console.log('[CATALOG]   ofm 新模型(禁用行待人工钉 ctx): ' + ofm.addedDisabled.join(', '));
    if (anly.ctxUpdate) console.log('[CATALOG]   anly ctx: ' + anly.ctxUpdate);
    if (anly.disabled && anly.disabled.length) console.log('[CATALOG]   anly 禁用: ' + anly.disabled.join(', '));
    if (anly.addedDisabled && anly.addedDisabled.length) console.log('[CATALOG]   anly 新模型(禁用行): ' + anly.addedDisabled.join(', '));
    if (c.headConfig) console.log('[CATALOG]   覆盖文件: ' + c.headConfig + (c.headConfigChanged ? (apply ? '（已写回）' : '（--check 未写）') : '（无变化）'));
    if (c.audit && c.audit.length) console.log('[CATALOG]   审计 ' + c.audit.length + ' 条');
    if (c.errors && c.errors.length) console.log('[CATALOG]   错误(不致命): ' + c.errors.join(' | '));
  }
  if (reportPath) console.log('[CATALOG] 报告: ' + resolve(reportPath));
}

const unknownAll = !report.openrouter_catalog.ok && !(report.disable || []).length;
process.exit(apply ? 0 : ((report.disable || []).length || (report.enable || []).length ? 1 : (unknownAll ? 3 : 0)));
