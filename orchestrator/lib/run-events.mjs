// orchestrator/lib/run-events.mjs — T-153 Run 事件账本（append-only JSONL）
//
// 目的：给"一次运行"留下一条可回放的链（run_id → 事件序列），失败/卡死/写确认都进链，
//       避免"跑完了但不知道中间发生了什么"。借鉴 Nightingale 的 run_id 事件链思路，
//       但只做最小实现：不做告警平台、不做指标聚合。
//
// 目录布局（运行期数据，默认不入库）：
//   <root>/runs/<run_id>.jsonl     一次 run 的事件链（每行一个 JSON 对象，只追加）
//   <root>/proposals/<pid>.json    写提案（提案→diff→确认闸用，write-gate.mjs 落）
//   <root>/staging/<pid>/<n>.bin   提案暂存字节（确认后才落目标文件）
//
// 事件行字段：{ seq, ts, run_id, type, payload }
//   seq      该 run 内自增序号（从 1 开始）
//   ts       ISO 时间戳
//   type     见 EVENT_TYPES
//   payload  事件细节（自动脱敏：疑似密钥字段打码，长文本截断）
//
// 红线：
//   1. 只追加，不改写历史（append-only 是审计可信的前提）。
//   2. 不落密钥原文、不落大段原文（脱敏 + 截断在写入前做）。
//   3. 保留策略：默认只留最近 50 个 run 文件，旧的自动剪除（防事件膨胀）。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_ROOT = join(REPO_ROOT, 'orchestrator', 'run-events');

export const EVENT_TYPES = Object.freeze({
  RUN_START: 'run.start',
  RUN_END: 'run.end',
  RUN_ERROR: 'run.error',
  TASK_START: 'task.start',
  TASK_END: 'task.end',
  PROPOSAL_CREATED: 'proposal.created',
  PROPOSAL_CONFIRMED: 'proposal.confirmed',
  PROPOSAL_REJECTED: 'proposal.rejected',
  PROPOSAL_APPLIED: 'proposal.applied',
  WRITE_BLOCKED: 'write.blocked',
  WRITE_OVERRIDE: 'write.override',
  GATE_DENIED: 'gate.denied',
  // T-255：headless 证据收据外部锚——文件自记哈希=自证可伪造，必须账本锚（§7.2.4）
  EVIDENCE_RECEIPT: 'evidence.receipt',
});

const SECRET_KEY_RE = /(pass|passwd|password|secret|token|api[_-]?key|apikey|credential|private[_-]?key|authorization)/i;
const MAX_TEXT = 500;

function scrubValue(key, value, depth = 0) {
  if (SECRET_KEY_RE.test(String(key))) return '[redacted]';
  if (typeof value === 'string') return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + '...[truncated]' : value;
  if (Array.isArray(value)) return value.slice(0, 20).map(v => scrubValue('item', v, depth + 1));
  if (value && typeof value === 'object' && depth < 3) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubValue(k, v, depth + 1);
    return out;
  }
  return value;
}

export function scrubPayload(payload) {
  if (!payload || typeof payload !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(payload)) out[k] = scrubValue(k, v);
  return out;
}

export function newRunId(prefix = 'run') {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + 'T' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  return prefix + '-' + stamp + '-' + randomBytes(3).toString('hex');
}

export function createLedger({ root, keepRuns = 50 } = {}) {
  const base = resolve(root || process.env.TITAN_RUN_EVENTS_DIR || DEFAULT_ROOT);
  const runsDir = join(base, 'runs');
  const proposalsDir = join(base, 'proposals');
  const stagingDir = join(base, 'staging');

  function ensure() {
    for (const d of [runsDir, proposalsDir, stagingDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
  }

  function runFile(runId) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(runId || ''))) throw new Error('非法 run_id: ' + runId);
    return join(runsDir, runId + '.jsonl');
  }

  function append(runId, type, payload = {}) {
    ensure();
    const file = runFile(runId);
    let seq = 1;
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      if (lines.length) {
        try { seq = (JSON.parse(lines[lines.length - 1]).seq || lines.length) + 1; } catch { seq = lines.length + 1; }
      } else {
        seq = 1;
      }
    }
    const evt = {
      seq,
      ts: new Date().toISOString(),
      run_id: runId,
      type: String(type),
      payload: scrubPayload(payload),
    };
    appendFileSync(file, JSON.stringify(evt) + '\n', 'utf8');
    return evt;
  }

  function read(runId) {
    const file = runFile(runId);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return { seq: 0, ts: null, run_id: runId, type: 'ledger.corrupt', payload: { raw: l.slice(0, 120) } }; } });
  }

  function list({ limit = 20 } = {}) {
    ensure();
    if (!existsSync(runsDir)) return [];
    const items = [];
    for (const name of readdirSync(runsDir)) {
      if (!name.endsWith('.jsonl')) continue;
      const file = join(runsDir, name);
      const st = statSync(file);
      items.push({ runId: name.replace(/\.jsonl$/, ''), bytes: st.size, events: readFileSync(file, 'utf8').split('\n').filter(Boolean).length, mtime: st.mtimeMs });
    }
    items.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
    return items.slice(0, limit);
  }

  function prune() {
    ensure();
    const all = list({ limit: 100000 });
    const dropped = [];
    for (const item of all.slice(keepRuns)) {
      try { rmSync(join(runsDir, item.runId + '.jsonl'), { force: true }); dropped.push(item.runId); } catch { /* 剪除失败不阻塞主链 */ }
    }
    return dropped;
  }

  function summary(runId) {
    const events = read(runId);
    const counts = {};
    for (const e of events) counts[e.type] = (counts[e.type] || 0) + 1;
    return { runId, total: events.length, counts, first: events[0] ? events[0].ts : null, last: events[events.length - 1] ? events[events.length - 1].ts : null };
  }

  return { root: base, runsDir, proposalsDir, stagingDir, ensure, append, read, list, prune, summary, runFile };
}

export const ledger = createLedger();
export const { append, read, list, prune } = ledger;
export default ledger;
