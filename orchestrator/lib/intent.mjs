// orchestrator/lib/intent.mjs — T-166 intent 落盘（拆分计划 §4 R6 改 Telegram 网关形态）
//
// 背景：R6 原为「OpenClaw intent 入口」，但 OpenClaw 路径已被 Telegram 网关链取代
//       （orchestrator/titan-gateway.mjs + titan_telegram_bot.py，T-156 落地），
//       故 R6 重新定向到网关链：意图分类 → 落 reviews/_pending/intent-<ts>.json →
//       薄入口消费 → 回写 replyChannel。
//
// 纪律（对应 R2 契约冻结）：字段名只许追加、不许改名；enum 只许追加。
//   既有字段：intent / target / constraints / replyChannel
//   追加字段：runId / createdAt / source（可选）
//
// 红线：
//   - 不落密钥与长文本（target/constraints 长度上限；疑似密钥字样打码）。
//   - replyChannel 只落 chat id 标识（数字串或短 token），不落用户姓名/消息原文。
//   - 写盘失败不影响主链（intent 文件是审计面，不是执行依赖）。

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

// 网关/机器人三档模式 → intent enum（只追加：consult 为 T-166 新增）
export const INTENT_ENUM = Object.freeze(['scan', 'fix', 'design', 'implement', 'verify', 'consult']);
export const MODE_TO_INTENT = Object.freeze({ consult: 'consult', execute: 'fix', codegen: 'implement' });
export const MAX_TARGET = 500;
export const MAX_CONSTRAINTS = 500;
const SECRET_PAT = /(sk-[A-Za-z0-9]|AIza[0-9A-Za-z_-]{10,}|ghp_[0-9A-Za-z]{10,}|AKIA[0-9A-Z]{8,}|-----BEGIN)/;

function scrub(text, max) {
  let s = String(text == null ? '' : text);
  if (SECRET_PAT.test(s)) s = '[redacted: suspected secret]';
  if (s.length > max) s = s.slice(0, max) + '…[truncated]';
  return s;
}

export function validateIntent(intent) {
  if (!INTENT_ENUM.includes(intent)) {
    return { ok: false, reason: 'intent 非法（可选: ' + INTENT_ENUM.join('|') + '）: ' + intent };
  }
  return { ok: true, reason: '' };
}

// 构建一个 schema 形状的 intent 对象（字段名与 design-specs/intent.schema.json 一致）
export function buildIntent({ intent, target = '', constraints = '', replyChannel = '', runId = null, source = 'telegram-bot' }) {
  const chk = validateIntent(intent);
  if (!chk.ok) throw new Error(chk.reason);
  return {
    intent,
    target: scrub(target, MAX_TARGET),
    constraints: scrub(constraints, MAX_CONSTRAINTS),
    replyChannel: scrub(replyChannel, 64),
    runId,
    source,
    createdAt: new Date().toISOString(),
  };
}

// 落盘：reviews/_pending/intent-<ts><seq>.json（ts = epoch 毫秒，seq = 进程内自增，
// 防同一毫秒多次写盘文件名碰撞互覆——T-255 修意图测试在并行负载下的同 ms 竞态）
let _seq = 0;
export function writeIntentFile(intentObj, { reviewsRoot = join(REPO_ROOT, 'reviews') } = {}) {
  const dir = join(reviewsRoot, '_pending');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  _seq += 1;
  const file = join(dir, 'intent-' + Date.now() + String(_seq % 1000).padStart(3, '0') + '.json');
  writeFileSync(file, JSON.stringify(intentObj, null, 2), 'utf8');
  return file;
}

export function readIntentFile(file) {
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function listIntentFiles({ reviewsRoot = join(REPO_ROOT, 'reviews') } = {}) {
  const dir = join(reviewsRoot, '_pending');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^intent-\d+\.json$/.test(f)).sort().reverse();
}

export default { INTENT_ENUM, MODE_TO_INTENT, validateIntent, buildIntent, writeIntentFile, readIntentFile, listIntentFiles };
