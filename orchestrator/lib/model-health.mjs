// orchestrator/lib/model-health.mjs — T-172 模型健康注册表（共享探针 + TTL）+ 分档派单建议
//
// 目标（用户 2026-10-21 指令："让免费低档模型做该做的事是你要规划的"）：
//   1. 让四客户端随时知道**每个模型当前是否可用 / 多快 / 还剩多少额度**——健康不可见就无法调度；
//   2. 把**任务分档**（机械活 / 边界实现 / 架构 / 审查 / 长任务）映射到**模型分档**（light / medium / heavy）；
//   3. 派单时优先消耗**额度不受限的平台**（rpd=null），把 OpenRouter 账号级 50/天 省给强档。
//
// 定位与红线：
//   - **只读**：本模块不改任何模型配置、不改客户端模型选择（自动下发默认路由属用户拍板事项，见 T-172 任务卡）；
//     它的产出是**建议**（recommend），派不派由协调者决定。
//   - **零依赖**（只用 node: 内置 fetch）；分档表在 orchestrator/config/model-tiers.json（入 git，可版本化）。
//   - **密钥只走 env**（FREELLMAPI_API_KEY），不进 URL、不进命令行（M5）。
//   - **UNKNOWN ≠ FAIL**：探针没跑成（网关挂/没 key/超时）一律记 UNKNOWN，不当通过也不当失败。
//
// 与既有口径的关系：
//   - 与 freellmapi 的 `titan` profile（强档链）不同：本模块是**任务→模型**的映射与健康视图，不改 profile 成员。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_CONFIG_PATH = join(REPO_ROOT, 'orchestrator', 'config', 'model-tiers.json');
export const DEFAULT_CACHE_PATH = join(REPO_ROOT, 'orchestrator', 'run-events', 'model-health-cache.json');
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
export const TIERS = Object.freeze(['light', 'medium', 'heavy']);
export const HEALTH_STATES = Object.freeze(['healthy', 'stale', 'down', 'unknown']);

let configCache = null;

// 读分档表（带内存缓存）
export function loadTiers(configPath = DEFAULT_CONFIG_PATH) {
  if (configCache && configCache.path === configPath) return configCache.value;
  if (!existsSync(configPath)) throw new Error('分档表不存在: ' + configPath);
  let value;
  try {
    value = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new Error('分档表不是合法 JSON: ' + e.message);
  }
  if (!value || !Array.isArray(value.models)) throw new Error('分档表缺少 models 数组');
  const ids = new Set();
  for (const m of value.models) {
    if (!m || !m.id) throw new Error('分档表存在无 id 条目');
    if (ids.has(m.id)) throw new Error('分档表 id 重复: ' + m.id);
    ids.add(m.id);
    if (!TIERS.includes(m.tier)) throw new Error('分档表非法 tier: ' + m.id + ' → ' + m.tier);
  }
  configCache = { path: configPath, value };
  return value;
}

export function listModels(config = loadTiers()) {
  return config.models.slice();
}

export function getModel(id, config = loadTiers()) {
  return config.models.find((m) => m.id === id) || null;
}

export function getTaskTier(name, config = loadTiers()) {
  const t = (config.taskTiers || {})[name];
  if (!t) throw new Error('未知任务档位: ' + name + '（允许: ' + Object.keys(config.taskTiers || {}).join(' / ') + '）');
  return t;
}

// ── 缓存（TTL） ────────────────────────────────────────────────────────────
export function readCache(cachePath = DEFAULT_CACHE_PATH) {
  if (!existsSync(cachePath)) return {};
  try {
    const j = JSON.parse(readFileSync(cachePath, 'utf8'));
    return (j && typeof j === 'object') ? j : {};
  } catch { return {}; }
}

export function writeCache(cache, cachePath = DEFAULT_CACHE_PATH) {
  mkdirSync(dirname(cachePath), { recursive: true });
  writeFileSync(cachePath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
  return cachePath;
}

export function cacheEntry(cache, id, ttlMs = DEFAULT_TTL_MS, now = Date.now()) {
  const e = cache && cache[id];
  if (!e || typeof e.checked_at !== 'number') return null;
  const age = now - e.checked_at;
  if (age > ttlMs) return null;
  return { ...e, age_ms: age };
}

// ── 探针 ──────────────────────────────────────────────────────────────────
// 一次探针 = 一个最小 chat  completions + 一个 tool 定义：
//   status=200 且 tool_calls 有值 → 可用且支持工具（派活的最低门槛）。
export async function probeModel({
  id, baseUrl, keyEnv = 'FREELLMAPI_API_KEY', timeoutMs = 20000, fetchImpl = null, env = null,
} = {}) {
  const apiKey = (env || process.env)[keyEnv];
  if (!apiKey) {
    return { id, ok: false, state: 'unknown', reason: 'missing_key:' + keyEnv, latency_ms: null, tools: false, checked_at: Date.now() };
  }
  const doFetch = fetchImpl || fetch;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: id,
        messages: [{ role: 'user', content: 'Call ping({n:1}).' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: { n: { type: 'integer' } } } } }],
        max_tokens: 2048,
      }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    const text = await res.text();
    if (res.status !== 200) {
      return { id, ok: false, state: 'down', reason: 'http_' + res.status, http_status: res.status, latency_ms: latency, tools: false, checked_at: Date.now(), body_head: text.slice(0, 200) };
    }
    let hasTool = false;
    try {
      const j = JSON.parse(text);
      const msg = j && j.choices && j.choices[0] && j.choices[0].message;
      hasTool = !!(msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0);
    } catch { /* 解析失败按无 tool_calls 计 */ }
    return {
      id, ok: true, state: 'healthy', reason: hasTool ? 'ok_with_tools' : 'ok_no_tool_calls',
      http_status: res.status, latency_ms: latency, tools: hasTool, checked_at: Date.now(),
    };
  } catch (e) {
    const latency = Date.now() - started;
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { id, ok: false, state: 'unknown', reason: aborted ? 'timeout' : ('error:' + String((e && e.message) || e).slice(0, 120)), latency_ms: latency, tools: false, checked_at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

// ── T-251 大上下文实战探针（T-248 §7.5 活例：小探针 200 ≠ 大上下文不断流）────
// 反幻觉映射：小探针通过 = REFERENCED（引用级证据）；大上下文流式完成 = VERIFIED(firsthand)；
// 大上下文断流 = 小探针证据被 REFUTED，"healthy" 徽章作废（recommend 对 needsContext 档位直接排除）。
// 成本红线（SOP 踩坑 B：OpenRouter 50/天账号级）：默认只给不限量平台（rpd=null）加探；
// 计量档保持旧口径 REFERENCED。配置 gateway.ctxProbe: {enabled, minChars, timeoutMs, unlimitedOnly}。
export const PING_TOOL = Object.freeze({
  type: 'function', function: { name: 'ping', description: 'p', parameters: { type: 'object', properties: { n: { type: 'integer' } } } },
});

/** 确定性填充文本（≥minChars），行形如 REF-00042: ... TITAN-xxxxx（可 grep 防缓存假命中）。 */
export function buildCtxFiller(minChars = 24000) {
  let s = '';
  let i = 0;
  while (s.length < minChars && i < 100000) {
    s += 'REF-' + String(i).padStart(5, '0') + ': the codeword for slot ' + i + ' is TITAN-' + String((i * 7919) % 100000).padStart(5, '0') + '.\n';
    i += 1;
  }
  return s;
}

/**
 * 大上下文流式探针：~minChars 字符 + stream:true，判"首包到 [DONE] 全程不断"。
 * 断流（无 [DONE]）/ 超时 / 无 tool_calls → ok:false（down 语义：徽章作废）。
 * 网关中途断流不可换链（SOP 踩坑 J），所以只能实测。
 */
export async function probeContext({
  id, baseUrl, keyEnv = 'FREELLMAPI_API_KEY', timeoutMs = 90000, minChars = 24000, fetchImpl = null, env = null,
} = {}) {
  const apiKey = (env || process.env)[keyEnv];
  if (!apiKey) {
    return { id, ok: false, ctx: true, reason: 'missing_key:' + keyEnv, latency_ms: null, checked_at: Date.now() };
  }
  const doFetch = fetchImpl || fetch;
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({
        model: id,
        stream: true,
        max_tokens: 2048,
        tools: [PING_TOOL],
        messages: [{ role: 'user', content: buildCtxFiller(minChars) + '\nAfter the reference lines above, call ping({n:1}).' }],
      }),
      signal: controller.signal,
    });
    const latency = Date.now() - started;
    const text = await res.text();
    if (res.status !== 200) {
      return { id, ok: false, ctx: true, reason: 'http_' + res.status, http_status: res.status, latency_ms: latency, checked_at: Date.now(), body_head: text.slice(0, 200) };
    }
    const done = text.includes('[DONE]');
    const hasTool = /"tool_calls"/.test(text);
    if (!done) {
      return { id, ok: false, ctx: true, reason: 'stream_incomplete', http_status: 200, latency_ms: latency, checked_at: Date.now(), body_head: text.slice(-120) };
    }
    if (!hasTool) {
      return { id, ok: false, ctx: true, reason: 'ctx_no_tool_calls', http_status: 200, latency_ms: latency, checked_at: Date.now() };
    }
    return { id, ok: true, ctx: true, reason: 'ctx_ok', http_status: 200, latency_ms: latency, checked_at: Date.now() };
  } catch (e) {
    const latency = Date.now() - started;
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || '')));
    return { id, ok: false, ctx: true, reason: aborted ? 'ctx_timeout' : ('error:' + String((e && e.message) || e).slice(0, 120)), latency_ms: latency, checked_at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

// 批量探针（带 TTL 缓存复用）；返回 { entries, probed, cached }
// T-251：小探针通过后，按 gateway.ctxProbe 给不限量平台追加上下文探针，
// entry 上带 fidelity（firsthand|refuted|referenced）+ ctx 子对象。ctxProbe: null=按配置, false=强关, true=强开。
export async function probeModels({
  ids, config = loadTiers(), ttlMs = DEFAULT_TTL_MS, refresh = false, cachePath = DEFAULT_CACHE_PATH,
  fetchImpl = null, env = null, concurrency = 3, now = Date.now(), ctxProbe = null,
} = {}) {
  const cache = readCache(cachePath);
  const entries = {};
  const toProbe = [];
  for (const id of ids) {
    const hit = refresh ? null : cacheEntry(cache, id, ttlMs, now);
    if (hit) { entries[id] = hit; continue; }
    toProbe.push(id);
  }
  const gw = config.gateway || {};
  const ctxCfg = Object.assign(
    { enabled: false, minChars: 24000, timeoutMs: 90000, unlimitedOnly: true },
    gw.ctxProbe || {},
  );
  if (ctxProbe === false) { ctxCfg.enabled = false; }
  if (ctxProbe === true) { ctxCfg.enabled = true; ctxCfg.platforms = null; }  // --ctx-probe：调试强开，无视白名单
  const byId = new Map((config.models || []).map((m) => [m.id, m]));
  for (let i = 0; i < toProbe.length; i += concurrency) {
    const batch = toProbe.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(async (id) => {
      const r = await probeModel({ id, baseUrl: gw.baseUrl, keyEnv: gw.keyEnv, timeoutMs: gw.probeTimeoutMs, fetchImpl, env });
      if (!r.ok || !ctxCfg.enabled) {
        if (r.ok) r.fidelity = 'referenced';   // 小探针通过但按口径不加探 → 引用级
        return r;
      }
      const m = byId.get(id);
      const unlimited = m === undefined || m === null || m.rpd === null || m.rpd === undefined;
      if (ctxCfg.unlimitedOnly && !unlimited) { r.fidelity = 'referenced'; return r; }
      // platforms 白名单（探测纪律：弱通道/计量渠道不加探，只给已实证断流的平台加探）；null=全平台
      if (Array.isArray(ctxCfg.platforms) && ctxCfg.platforms.length && !ctxCfg.platforms.includes(m && m.platform)) { r.fidelity = 'referenced'; return r; }
      const ctx = await probeContext({
        id, baseUrl: gw.baseUrl, keyEnv: gw.keyEnv, timeoutMs: ctxCfg.timeoutMs, minChars: ctxCfg.minChars, fetchImpl, env,
      });
      r.ctx = ctx;
      r.ctx_checked_at = ctx.checked_at;
      r.fidelity = ctx.ok ? 'firsthand' : 'refuted';
      return r;
    }));
    for (const r of results) {
      entries[r.id] = r;
      cache[r.id] = r;
    }
  }
  if (toProbe.length) writeCache(cache, cachePath);
  return { entries, probed: toProbe, cached: ids.filter((id) => !toProbe.includes(id)) };
}

// 健康判定：TTL 内 → healthy；TTL 外 → stale；探针失败按 down / unknown 区分
export function evaluateHealth(entry, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  if (!entry) return 'unknown';
  if (entry.state === 'down') return 'down';
  if (entry.state === 'unknown') return 'unknown';
  const age = now - (entry.checked_at || 0);
  if (age > ttlMs) return 'stale';
  return 'healthy';
}

// ── 派单建议（recommend）──────────────────────────────────────────────────
// 排序键（依次比较）：
//   1. 健康：healthy > unknown > stale（down 直接排除）
//   2. 平台额度：rpd=null（不限量）优先 → rpd=200 → rpd=50（把 OpenRouter 50/天 省给强档）
//   3. 档位：任务 prefer 的档位优先，再按档位升序（light → heavy）
//   4. 能力：intelligenceRank 高优先
//   5. 速度：latency 低优先
export function recommend({
  config = loadTiers(), health = {}, taskTier, taskKind = null, limit = 5,
  allowPaid = false, requireTools = null, ttlMs = DEFAULT_TTL_MS, now = Date.now(),
  weakFilter = 'any',
} = {}) {
  const policy = getTaskTier(taskTier, config);
  const needTools = requireTools === null ? (policy.requireTools !== undefined ? policy.requireTools : true) : requireTools;
  const order = [policy.prefer, ...TIERS.filter((t) => t !== policy.prefer)];
  const rows = [];
  for (const m of config.models) {
    const allowed = policy.allowedModelTiers || [];
    if (!allowed.includes(m.tier)) continue;
    if (!allowPaid && m.free === false) continue;
    if (weakFilter === 'only' && m.weak !== true) continue;
    if (weakFilter === 'exclude' && m.weak === true) continue;
    const h = health[m.id] || null;
    const state = evaluateHealth(h, { ttlMs, now });
    if (state === 'down') continue;
    if (m.tools === false) continue;                       // 分档表登记就不支持工具 → 直接排除
    if (needTools && h && h.tools === false) continue;     // 实测探针没出 tool_calls → 不派需要工具的活
    // T-251 分级裁决：实战断流被证的模型，大上下文档位（policy.needsContext）直接排除——
    // 小探针 healthy 救不回来（REFERENCED 被 REFUTED，不许冒充 VERIFIED）。
    if (policy.needsContext === true && h && h.fidelity === 'refuted') continue;
    if (taskKind && Array.isArray(m.taskKinds) && m.taskKinds.length && !m.taskKinds.includes(taskKind)) continue;
    const quotaRank = m.rpd === null || m.rpd === undefined ? 0 : (m.rpd <= 200 ? 1 : 2);
    rows.push({
      id: m.id, tier: m.tier, platform: m.platform, free: m.free, rpd: m.rpd === undefined ? null : m.rpd,
      health: state, latency_ms: h && typeof h.latency_ms === 'number' ? h.latency_ms : null,
      tools_probe: h ? h.tools === true : null,
      intelligenceRank: typeof m.intelligence_rank === 'number' ? m.intelligence_rank : (typeof m.intelligenceRank === 'number' ? m.intelligenceRank : null),
      quotaRank, note: m.note || '',
      weak: m.weak === true,
      _tierOrder: order.indexOf(m.tier),
    });
  }
  rows.sort((a, b) => {
    // 排序：健康 → 档位优先（这是"低档干低档活"的落点）→ 平台额度 → 能力 → 速度
    const hs = { healthy: 0, unknown: 1, stale: 2 };
    if (hs[a.health] !== hs[b.health]) return hs[a.health] - hs[b.health];
    if (a._tierOrder !== b._tierOrder) return a._tierOrder - b._tierOrder;
    if (a.quotaRank !== b.quotaRank) return a.quotaRank - b.quotaRank;
    const ar = a.intelligenceRank === null ? -1 : a.intelligenceRank;
    const br = b.intelligenceRank === null ? -1 : b.intelligenceRank;
    if (ar !== br) return br - ar;
    const al = a.latency_ms === null ? Number.MAX_SAFE_INTEGER : a.latency_ms;
    const bl = b.latency_ms === null ? Number.MAX_SAFE_INTEGER : b.latency_ms;
    return al - bl;
  });
  return {
    task_tier: taskTier,
    policy,
    candidates: rows.slice(0, limit).map(({ _tierOrder, ...rest }) => rest),
    total_candidates: rows.length,
  };
}

export function renderHealthTable(entries, models, { ttlMs = DEFAULT_TTL_MS, now = Date.now() } = {}) {
  const byId = new Map(models.map((m) => [m.id, m]));
  const lines = [];
  for (const id of Object.keys(entries).sort()) {
    const e = entries[id];
    const m = byId.get(id) || {};
    const state = evaluateHealth(e, { ttlMs, now });
    lines.push([
      id.padEnd(34),
      (m.tier || '?').padEnd(7),
      (m.platform || '?').padEnd(11),
      (m.rpd === null || m.rpd === undefined ? 'unlimited' : 'rpd=' + m.rpd).padEnd(11),
      state.padEnd(8),
      (e.latency_ms === null || e.latency_ms === undefined ? '-' : e.latency_ms + 'ms').padEnd(9),
      (e.tools ? 'tools=Y' : 'tools=N').padEnd(8),
      (e.fidelity || 'ref*'),  // T-251: firsthand=实战过 ctx / refuted=ctx断流 / ref*=只有引用级小探针
      e.reason || '',
    ].join(' '));
  }
  return lines.join('\n');
}

export function renderRecommendation(rec) {
  const lines = [];
  lines.push('任务档位: ' + rec.task_tier + '（' + rec.policy.label + '）  优先档位: ' + rec.policy.prefer);
  lines.push('规则: ' + rec.policy.rule);
  if (!rec.candidates.length) {
    lines.push('（无候选：健康探针未通过或该档位没有可用模型）');
    return lines.join('\n');
  }
  rec.candidates.forEach((c, i) => {
    lines.push([
      String(i + 1) + '.', c.id.padEnd(34), c.tier.padEnd(7),
      (c.platform || '?').padEnd(11),
      (c.rpd === null ? 'unlimited' : 'rpd=' + c.rpd).padEnd(11),
      c.health.padEnd(8),
      (c.latency_ms === null ? '-' : c.latency_ms + 'ms').padEnd(9),
      c.note || '',
    ].join(' '));
  });
  return lines.join('\n');
}

export default {
  DEFAULT_CONFIG_PATH, DEFAULT_CACHE_PATH, DEFAULT_TTL_MS, TIERS, HEALTH_STATES,
  loadTiers, listModels, getModel, getTaskTier, probeModel, probeModels, probeContext, buildCtxFiller, PING_TOOL,
  evaluateHealth, recommend, renderHealthTable, renderRecommendation, readCache, writeCache, cacheEntry,
};
