#!/usr/bin/env node
// orchestrator/scheduler/model-health-refresh.mjs — T-186 健康表保鲜（supervisor 受管）
//
// 用法:
//   node orchestrator/scheduler/model-health-refresh.mjs --once           # 跑一轮就退出
//   node orchestrator/scheduler/model-health-refresh.mjs --dry-run        # 只列待探清单，不发请求
//   node orchestrator/scheduler/model-health-refresh.mjs                  # 常驻，每 2 小时一轮
//   node orchestrator/scheduler/model-health-refresh.mjs --include-metered # 连计量档（OpenRouter 等）一起探
//
// 红线（用户 2026-10-22/23 裁定 + 四席共识）：
//   1. 默认**只探不限量平台**（rpd == null：kilo/google/septor/waterfall 等）——
//      防再把 OpenRouter 账号级 50/天探挂；
//   2. **复用** lib/model-health.mjs 的 probeModels，不另写探针；
//   3. 密钥只走 env / titan_secrets.env（M5），不进命令行、不落日志；
//   4. 网关不可达整轮记 unknown 不重试轰炸（一轮失败等下轮周期）。

import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadTiers, probeModels, DEFAULT_CACHE_PATH } from '../lib/model-health.mjs';
import { loadSecretsEnv } from '../lib/alert.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const once = argv.includes('--once');
const dryRun = argv.includes('--dry-run');
const includeMetered = argv.includes('--include-metered');
const intervalHours = Math.max(0.25, Number(flagValue('--interval-hours') || 2));
const statePath = resolve(flagValue('--state') || join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor', 'model-health-refresh.json'));
// --tiers <path>：注入分档表（T-192 发抖治理：测试/演练用夹具，不依赖活 model-tiers.json）
const tiersPath = flagValue('--tiers');

function writeJson(path, value) {
  mkdirSync(resolve(path).replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

/** 筛选本轮应探的模型 id（纯函数，可单测）。默认排除计量档（rpd 有值）。 */
export function selectProbeIds(models, { includeMetered = false } = {}) {
  const out = [];
  for (const m of models || []) {
    if (!m || !m.id) continue;
    if (m.free === false) continue;
    if (!includeMetered && m.rpd !== null && m.rpd !== undefined) continue;
    out.push(m.id);
  }
  return out;
}

async function tick(n) {
  const t0 = Date.now();
  loadSecretsEnv({ repoRoot: REPO_ROOT, env: process.env, only: ['FREELLMAPI_API_KEY', 'TITAN_FREELLM_API_KEY'] });
  // T-251（T-236 同类键名失配）：本仓 titan_secrets.env 实际键是 TITAN_FREELLM_API_KEY，
  // 只认 FREELLMAPI_API_KEY 会恒 missing_key → 健康缓存 9 天不保鲜（10-31 实证）。
  if (!process.env.FREELLMAPI_API_KEY && process.env.TITAN_FREELLM_API_KEY) {
    process.env.FREELLMAPI_API_KEY = process.env.TITAN_FREELLM_API_KEY;
  }
  const config = tiersPath ? loadTiers(resolve(tiersPath)) : loadTiers();
  const ids = selectProbeIds(config.models, { includeMetered });
  if (dryRun) {
    const metered = (config.models || []).filter((m) => m.rpd !== null && m.rpd !== undefined && m.free !== false).map((m) => m.id);
    console.log('[HEALTH-REFRESH] dry-run 待探 ' + ids.length + ' 个（不限量）: ' + ids.join(', '));
    console.log('[HEALTH-REFRESH] dry-run 跳过计量档 ' + metered.length + ' 个（--include-metered 可打开）');
    return { ok: true, dryRun: true, ids };
  }
  if (!ids.length) {
    console.log('[HEALTH-REFRESH] 无待探模型（检查 model-tiers.json）');
    writeJson(statePath, { updated_at: new Date().toISOString(), tick: n, probed: 0, note: 'empty_ids' });
    return { ok: false };
  }
  if (!process.env.FREELLMAPI_API_KEY) {
    console.log('[HEALTH-REFRESH] 缺 FREELLMAPI_API_KEY（env / titan_secrets.env），本轮跳过探针');
    writeJson(statePath, { updated_at: new Date().toISOString(), tick: n, probed: 0, note: 'missing_key' });
    return { ok: false };
  }
  let result;
  try {
    result = await probeModels({ ids, config, refresh: true });
  } catch (e) {
    console.log('[HEALTH-REFRESH] 探针异常: ' + String((e && e.message) || e).slice(0, 200));
    writeJson(statePath, { updated_at: new Date().toISOString(), tick: n, last_error: String((e && e.message) || e).slice(0, 300) });
    return { ok: false };
  }
  const states = {};
  for (const [id, e] of Object.entries(result.entries || {})) {
    states[e.state] = (states[e.state] || 0) + 1;
  }
  console.log('[HEALTH-REFRESH] 第 ' + n + ' 轮：探 ' + result.probed.length + ' 个 → ' + JSON.stringify(states) + '（' + (Date.now() - t0) + 'ms）');
  writeJson(statePath, {
    updated_at: new Date().toISOString(), tick: n, duration_ms: Date.now() - t0,
    probed: result.probed.length, states, include_metered: includeMetered,
    cache_path: DEFAULT_CACHE_PATH,
  });
  return { ok: true, states };
}

// 仅作为 CLI 直接执行时进入主循环；被 import 时只导出 selectProbeIds（防测试挂起）
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let n = 0;
  for (;;) {
    n += 1;
    await tick(n);
    if (once || dryRun) break;
    const sleepMs = intervalHours * 3600 * 1000;
    console.log('[HEALTH-REFRESH] 下轮在 ' + intervalHours + ' 小时后（' + n + '）');
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  process.exit(0);
}
