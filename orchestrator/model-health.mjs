#!/usr/bin/env node
// orchestrator/model-health.mjs — 模型健康注册表 CLI（T-172）
// 用法: node orchestrator/model-health.mjs [--task <tier>] [--kind <taskKind>] [--model <id>]
//       node orchestrator/model-health.mjs --all [--refresh] [--no-probe] [--json]
// 退出码: 0=OK, 1=有阻断问题（指定任务档位无健康候选）, 2=用法错误, 3=UNKNOWN（网关不可达/无 key）
//
// 注意：本 CLI **只读 + 只建议**：不修改任何模型配置、不改客户端模型选择（自动下发默认路由需用户拍板）。

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadTiers, listModels, getModel, getTaskTier, probeModels, evaluateHealth,
  recommend, renderHealthTable, renderRecommendation, DEFAULT_CONFIG_PATH, DEFAULT_CACHE_PATH, DEFAULT_TTL_MS,
} from './lib/model-health.mjs';

const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const asJson = argv.includes('--json');
const refresh = argv.includes('--refresh');
const noProbe = argv.includes('--no-probe');
const taskTier = flagValue('--task');
const taskKind = flagValue('--kind');
const modelId = flagValue('--model');
const configPath = resolve(flagValue('--config') || DEFAULT_CONFIG_PATH);
const cachePath = resolve(flagValue('--cache') || DEFAULT_CACHE_PATH);
const ttlMs = Number(flagValue('--ttl') || DEFAULT_TTL_MS);
const limit = Number(flagValue('--limit') || 5);
const allowPaid = argv.includes('--allow-paid');

if (argv.includes('--help') || argv.includes('-h') || (!taskTier && !modelId && !argv.includes('--all'))) {
  console.log([
    '用法: node orchestrator/model-health.mjs [options]',
    '  --task <tier>    任务档位: mechanical | bounded_code | architecture | review | long_run',
    '  --kind <kind>    任务类型（进一步收窄候选，如 summarize / new_module / review）',
    '  --model <id>     只探一个模型',
    '  --all            探全部模型并打健康表',
    '  --limit <n>      recommend 返回条数（默认 5）',
    '  --ttl <ms>       健康 TTL（默认 600000）',
    '  --refresh        忽略缓存，重新探',
    '  --no-probe       不探针（只用缓存/离线视图）',
    '  --no-ctx         关大上下文探针（T-251：默认按 gateway.ctxProbe 只探白名单平台）',
    '  --ctx-probe      无视平台白名单强开上下文探针（调试用，耗被探平台额度）',
    '  --allow-paid     允许付费模型进候选（默认只给免费档）',
    '  --json           输出 JSON',
    '退出码: 0=OK 1=无健康候选 2=用法错误 3=UNKNOWN（网关不可达/缺 key）',
  ].join('\n'));
  process.exit(argv.includes('--help') || argv.includes('-h') ? 0 : 2);
}

let config;
try {
  config = loadTiers(configPath);
} catch (e) {
  console.error('[MODEL-HEALTH] 分档表加载失败: ' + e.message);
  process.exit(2);
}

// T-251：CLI 手动探针也从 titan_secrets.env 装 key（含 T-236 同类键名别名）
{
  const { loadSecretsEnv } = await import('./lib/alert.mjs');
  loadSecretsEnv({ repoRoot: REPO_ROOT, env: process.env, only: ['FREELLMAPI_API_KEY', 'TITAN_FREELLM_API_KEY'] });
  if (!process.env.FREELLMAPI_API_KEY && process.env.TITAN_FREELLM_API_KEY) {
    process.env.FREELLMAPI_API_KEY = process.env.TITAN_FREELLM_API_KEY;
  }
}

let ids = [];
if (modelId) {
  if (!getModel(modelId, config)) {
    console.error('[MODEL-HEALTH] 分档表里没有该模型: ' + modelId);
    process.exit(2);
  }
  ids = [modelId];
} else if (taskTier) {
  try { getTaskTier(taskTier, config); } catch (e) { console.error('[MODEL-HEALTH] ' + e.message); process.exit(2); }
  const policy = getTaskTier(taskTier, config);
  ids = listModels(config).filter((m) => policy.allowedModelTiers.includes(m.tier) && (allowPaid || m.free !== false)).map((m) => m.id);
} else {
  ids = listModels(config).map((m) => m.id);
}

// 探针（可跳过：离线只读缓存）
let entries = {};
let probed = [];
// T-251：--no-ctx 强关大上下文探针；--ctx-probe 无视平台白名单强开（调试用，耗被探平台额度）
const ctxOverride = argv.includes('--no-ctx') ? false : (argv.includes('--ctx-probe') ? true : null);
if (!noProbe) {
  const res = await probeModels({ ids, config, ttlMs, refresh, cachePath, ctxProbe: ctxOverride });
  entries = res.entries;
  probed = res.probed;
} else {
  const { readCache, cacheEntry } = await import('./lib/model-health.mjs');
  const cache = readCache(cachePath);
  for (const id of ids) {
    const hit = cacheEntry(cache, id, ttlMs);
    if (hit) entries[id] = hit;
  }
}

const now = Date.now();
const states = ids.map((id) => evaluateHealth(entries[id], { ttlMs, now }));
const unknownCount = states.filter((s) => s === 'unknown').length;
const healthyCount = states.filter((s) => s === 'healthy').length;

let rec = null;
if (taskTier) {
  rec = recommend({ config, health: entries, taskTier, taskKind, limit, allowPaid, ttlMs, now });
}

if (asJson) {
  console.log(JSON.stringify({
    gateway: config.gateway, ttl_ms: ttlMs, probed, healthy: healthyCount, unknown: unknownCount,
    health: ids.map((id) => ({ id, state: evaluateHealth(entries[id], { ttlMs, now }), entry: entries[id] || null })),
    recommendation: rec,
  }, null, 2));
} else {
  console.log('[MODEL-HEALTH] 探针 ' + probed.length + ' 个 / 缓存复用 ' + (ids.length - probed.length) + ' 个；healthy=' + healthyCount + ' unknown=' + unknownCount);
  console.log(renderHealthTable(entries, listModels(config).filter((m) => ids.includes(m.id)), { ttlMs, now }));
  if (rec) {
    console.log('---');
    console.log(renderRecommendation(rec));
  }
  if (unknownCount === ids.length && ids.length > 0) {
    console.log('[MODEL-HEALTH] UNKNOWN = 所有候选都没探成（网关不可达/缺 key/超时）——显式未知，不等于不可用，也不等于可用');
  }
}

if (rec && rec.candidates.length === 0) {
  console.error('[MODEL-HEALTH] 任务档位 ' + taskTier + ' 没有健康候选（需要换档位或先探活）');
  process.exit(1);
}
process.exit(0);
