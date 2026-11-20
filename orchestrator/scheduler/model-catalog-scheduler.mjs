#!/usr/bin/env node
// orchestrator/scheduler/model-catalog-scheduler.mjs — T-179 定时免维护（freellmapi 免费池）
//
// 用法:
//   node orchestrator/scheduler/model-catalog-scheduler.mjs --once              # 跑一轮就退出（测试/手动）
//   node orchestrator/scheduler/model-catalog-scheduler.mjs                      # 常驻，每 6 小时一轮
//   node orchestrator/scheduler/model-catalog-scheduler.mjs --interval-hours 3 --probe
//
// 行为：拉目录 → 分类 → 剔除（禁下架/转收费/占位）→ 入池（先禁后探）→ 复检转正 → 有变化才告警
// 红线：密钥只从 env / titan_secrets.env 读；告警失败不打断主链；状态写 run-events（运行期数据不入库）

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCatalogSync } from '../lib/catalog-runner.mjs';
import { runChainHeadsSync } from '../lib/chain-heads.mjs';
import { loadSecretsEnv, sendTelegram, formatCatalogChange } from '../lib/alert.mjs';
import { appendChainSyncToMessage } from '../lib/catalog-alert-format.mjs';
import { execSync } from 'node:child_process';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const once = argv.includes('--once');
const probe = argv.includes('--probe');
const _rawInterval = flagValue('--interval-hours');
const _parsedInterval = Number(_rawInterval || 6);
// P1-07: 非法 --interval-hours 必须显式拒绝（此前 NaN → Math.max(1,NaN)=NaN → 1ms 循环洪水执行 apply）
if (_rawInterval !== null && (!Number.isFinite(_parsedInterval) || _parsedInterval <= 0)) {
  console.error('[SCHED] 非法 --interval-hours: ' + JSON.stringify(_rawInterval) + '（须为 >0 的有限数）');
  process.exit(2);
}
const intervalHours = _parsedInterval;
const gatewayUrl = flagValue('--gateway') || process.env.FREELLMAPI_BASE_URL || 'http://127.0.0.1:3001';
const statePath = resolve(flagValue('--state') || join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor', 'model-catalog-scheduler.json'));
const lastReportPath = resolve(flagValue('--last-report') || join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor', 'model-catalog-last-report.json'));

function writeJson(path, value) {
  mkdirSync(resolve(path).replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

async function tick(n) {
  const t0 = Date.now();
  // 密钥：env 优先，其次 gitignored 的 titan_secrets.env（只取需要的两个键）
  loadSecretsEnv({ repoRoot: REPO_ROOT, env: process.env, only: ['TITAN_BOT_TOKEN', 'TITAN_ALLOWED_USER_IDS', 'FREELLMAPI_API_KEY', 'ANYROUTER_API_KEY'] });

  // T-253: 先跑 remediate 再跑 catalog sync（防死 key 复活闭环：gen-config 重启时 upsert 会把已禁 key 复活）
  if (!once || argv.includes('--remediate')) {
    try {
      console.log('[SCHED] remediate-health start...');
      const remediatePath = resolve(REPO_ROOT, 'freellmapi-src', 'remediate-health.cjs');
      const out = execSync(`node ${remediatePath}`, { cwd: resolve(REPO_ROOT, 'freellmapi-src'), encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
      console.log('[SCHED] remediate-health done:\n' + out.slice(-2000));
    } catch (e) {
      console.log('[SCHED] remediate-health 失败(不阻塞主链): ' + String((e && e.stdout) || e).slice(0, 300));
    }
  }

  let report;
  try {
    report = await runCatalogSync({ repoRoot: REPO_ROOT, gatewayUrl, apiKey: process.env.FREELLMAPI_API_KEY || '', apply: true, probe });
  } catch (e) {
    console.log('[SCHED] 第 ' + n + ' 轮失败: ' + String((e && e.message) || e).slice(0, 200));
    writeJson(statePath, { updated_at: new Date().toISOString(), last_error: String((e && e.message) || e).slice(0, 300), ticks: n });
    return { ok: false };
  }
  // T-202: 三条自带链（auto:kilo / auto:titan-ofm / Anlyrouter）目录同步——失败不致命
  let chainReport = null;
  try {
    chainReport = await runChainHeadsSync({ repoRoot: REPO_ROOT, dbPath: resolve(REPO_ROOT, 'freellmapi-src', 'server', 'data', 'freeapi.db'), apply: true });
    if (chainReport.changed) {
      console.log('[SCHED] 链同步有变化: kilo+=' + ((chainReport.kilo && chainReport.kilo.added) || []).length +
        ' ofm=' + (chainReport.ofm && chainReport.ofm.frozen ? '冻结' : '更新') +
        ' anly=' + (chainReport.anly && chainReport.anly.reachable ? '可达' : 'no-op'));
    }
  } catch (e) {
    console.log('[SCHED] 链同步失败(不致命): ' + String((e && e.message) || e).slice(0, 200));
  }
  let msg = formatCatalogChange(report);
  // T-202/T-372：链变化追加进告警（拼接逻辑抽离为纯函数并入单测；变化留痕=覆盖文件 git diff + 审计 jsonl + 此告警）
  msg = appendChainSyncToMessage(msg, chainReport);
  let alerted = null;
  if (msg) {
    alerted = await sendTelegram(msg);
    console.log('[SCHED] 有变更 → 告警 ' + (alerted.ok ? '已发 ' + alerted.sent + ' 个会话' : '失败: ' + (alerted.errors || []).join(' | ')));
  } else {
    console.log('[SCHED] 第 ' + n + ' 轮：无变化（保留 ' + (report.totals.keep || 0) + '）');
  }
  writeJson(lastReportPath, report);
  writeJson(statePath, {
    updated_at: new Date().toISOString(), tick: n, duration_ms: Date.now() - t0,
    totals: report.totals, alerted: alerted ? { ok: alerted.ok, sent: alerted.sent } : null,
    catalog_ok: report.openrouter_catalog.ok, gateway_ok: report.gateway.ok,
    chain: chainReport ? { changed: !!chainReport.changed, kilo_reachable: !!(chainReport.kilo && chainReport.kilo.reachable), ofm_frozen: !!(chainReport.ofm && chainReport.ofm.frozen), anly_reachable: !!(chainReport.anly && chainReport.anly.reachable) } : null,
  });
  return { ok: true, changed: !!msg };
}

let n = 0;
for (;;) {
  n += 1;
  try {
    await tick(n);
  } catch (e) {
    // P1-07 伴生: 单次 tick 未捕获异常不得杀死整个调度器
    console.error('[SCHED] tick ' + n + ' 未捕获异常（继续调度）: ' + String((e && e.message) || e).slice(0, 300));
    try { writeJson(statePath, { updated_at: new Date().toISOString(), last_error: String((e && e.message) || e).slice(0, 300), ticks: n }); } catch {}
  }
  if (once) break;
  const sleepMs = Math.max(1, intervalHours) * 3600 * 1000;
  console.log('[SCHED] 下轮在 ' + intervalHours + ' 小时后（' + n + '）');
  await new Promise((r) => setTimeout(r, sleepMs));
}
process.exit(0);
