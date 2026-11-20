#!/usr/bin/env node
// edit-issue.mjs —— ISSUE_REGISTRY.json 条目自动编辑模板（P0）
// 用途：输入 id/title/type/status/owner/description/files 等字段，自动完成
//   JSON 转义、逗号插入、括号闭合、时间戳填充，生成可直接合并的条目，
//   消除手工拼接 JSON 导致的语法错误（trailing comma、括号不匹配、重复条目等）。
// 用法示例：
//   node orchestrator/edit-issue.mjs --id T-131 --title "xxx" --type fix --status claimed --owner cline --description "xxx" --files ISSUE_REGISTRY.json --files design-specs/x.md
// 退出码：0=成功，1=运行时错误，2=参数错误，3=JSON 校验失败
import { readFileSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, extname, join, dirname } from 'node:path';
import { gate, classifyTarget, isHighRisk } from './lib/write-gate.mjs';
import {
  normalizeEvidenceLevel, normalizeStage, normalizeStageResults, normalizeTaskCard, normalizeFixRounds,
} from './lib/task-card.mjs';
import { verifyReceipt } from './verify-receipt.mjs';
import { patchOrInsertEntry, assertNonTargetPreserved } from './lib/entry-scoped-patch.mjs';
import { atomicWriteFileSync } from './lib/atomic-write.mjs';
import { writeClaimManifest } from './lib/claim-manifest.mjs';
// T-352：台账分片支持（registry.d/<id>.json 为真相源；ISSUE_REGISTRY.json 为 git-aware 聚合快照）
import { isSharded, shardPath, aggregateGitAware, metaPayload, parseShard, SHARD_DIR, SHARD_META } from './lib/ledger-aggregate.mjs';
// T-269：时间戳逻辑抽到 lib/beijing-time.mjs（可单测，且与机器 TZ 无关）。
// 旧实现先 `getTime() - off*60000` 再用本地时区取值 → UTC+8 机器上叠加两次 +8（实测偏差 8.0 小时）。
import { nowBeijing } from './lib/beijing-time.mjs';

const argv = process.argv.slice(2);
// 语义：缺省（未传该 flag）→ undefined（保留原值）；传入但无值 → null（显式置空）
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
function flagAll(name) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) {
      const v = argv[i + 1];
      if (v && !v.startsWith('--')) { out.push(v); i++; }
    }
  }
  return out;
}
// 按状态自动填充时间戳（仅对传入的 status 生效；未传入时保留原值）
function timestampsFor(status, prev) {
  const now = nowBeijing();
  const claimed_at = prev && prev.claimed_at ? prev.claimed_at :
    (['claimed','in_progress','verifying','done'].includes(status) ? now : null);
  const in_progress_at = prev && prev.in_progress_at ? prev.in_progress_at :
    (['in_progress','verifying','done'].includes(status) ? now : null);
  const done_at = prev && prev.done_at ? prev.done_at :
    (status === 'done' ? now : null);
  return { claimed_at, in_progress_at, done_at };
}

const id = flagValue('--id');
const title = flagValue('--title');
const type = flagValue('--type');
const status = flagValue('--status');
const owner = flagValue('--owner');
const description = flagValue('--description');
const files = flagAll('--files');
const branch = flagValue('--branch');
const registry = flagValue('--registry') ?? 'ISSUE_REGISTRY.json';
// T-352：分片模式检测（registry.d/ 存在且非空 → 真相源是 registry.d/<id>.json，ISSUE_REGISTRY.json 只是 git-aware 聚合快照）
const registryAbs = resolve(registry);
const shardDirAbs = join(dirname(registryAbs), SHARD_DIR);
const shardedMode = isSharded(shardDirAbs);
let shardAbs = null;
try { shardAbs = shardPath(shardDirAbs, id); } catch (e) {
  if (shardedMode) {
    console.error('[EDIT-ISSUE] --id 无法用作分片文件名: ' + e.message);
    process.exit(2);
  }
}
const verifier = flagValue('--verifier');
const evidenceJson = flagValue('--evidence');
const cvStatus = flagValue('--cv-status');
const cvVerifier = flagValue('--cv-verifier');
const cvEvidence = flagValue('--cv-evidence');
const fieldsJson = flagValue('--fields-json');
// T-171：任务卡字段（证据分级 / 阶段语义 / OUT_OF_SCOPE / 修正轮次）
const evidenceLevelArg = flagValue('--evidence-level');
const stageArg = flagValue('--stage');
const stageResultsArg = flagValue('--stage-results');
const taskCardArg = flagValue('--task-card');
const fixRoundsArg = flagValue('--fix-rounds');
const actor = flagValue('--by') || process.env.TITAN_ACTOR || 'unknown';
const gateReason = flagValue('--reason') || '';
const deferGate = argv.includes('--defer');
const autoCommit = argv.includes('--auto-commit');

if (!id) {
  console.error('[EDIT-ISSUE] 缺少必填参数: --id');
  console.error('用法: 新建 -> node orchestrator/edit-issue.mjs --id <id> --title <title> --type <type> --status <status> --owner <owner> --description <desc> [--files <f> ...] [--branch <b>] [--registry <path>] [--verifier <v>]');
  console.error('      更新 -> node orchestrator/edit-issue.mjs --id <id> [--status <status>] [--verifier <v>] [--owner <owner>] [--title <title>] [--type <type>] [--description <desc>] [--files <f> ...] [--branch <b>] [--registry <path>]');
  console.error('      证据 -> 追加 --evidence \'{"k":"v"}\'（合并进 evidence；路径须存在且非超时失败——T-240 证据闸）；M2 结果用 --cv-status / --cv-verifier / --cv-evidence');
  console.error('      回填 -> --fields-json <path>（UTF-8 JSON 文件，可含 title/description/type/status/owner/branch/verifier/files/evidence，精确回填免转义）');
  process.exit(2);
}
const validTypes = new Set(['feat','fix','docs','chore','refactor','test','research']);
if (type && !validTypes.has(type)) {
  console.error('[EDIT-ISSUE] --type 必须是: ' + [...validTypes].join(', '));
  process.exit(2);
}
const validStatuses = new Set(['todo','claimed','in_progress','verifying','done','blocked']);
if (status && !validStatuses.has(status)) {
  console.error('[EDIT-ISSUE] --status 必须是: ' + [...validStatuses].join(', '));
  process.exit(2);
}
if (!existsSync(registry)) {
  console.error('[EDIT-ISSUE] 注册表文件不存在: ' + resolve(registry));
  process.exit(1);
}

// 读取并解析（先验证原文件可解析）
let raw;
try { raw = readFileSync(registry, 'utf8'); } catch (e) {
  console.error('[EDIT-ISSUE] 读取失败: ' + e.message); process.exit(1);
}
let root;
try { root = JSON.parse(raw); } catch (e) {
  console.error('[EDIT-ISSUE] 原文件 JSON 不可解析，拒绝覆盖: ' + e.message);
  process.exit(3);
}
if (!root || !root.issues || typeof root.issues !== 'object') {
  console.error('[EDIT-ISSUE] 原文件缺少 issues 对象，拒绝操作'); process.exit(3);
}
const now = nowBeijing();
let prev;
let shardRawAtRead = null;
if (shardedMode) {
  // T-352：分片模式下，prev 的唯一真相源是目标分片（快照是派生物，不驱动 prev）
  if (shardAbs && existsSync(shardAbs)) {
    try { shardRawAtRead = readFileSync(shardAbs, 'utf8'); } catch (e) {
      console.error('[EDIT-ISSUE] 读取目标分片失败: ' + e.message); process.exit(1);
    }
    try { prev = parseShard(shardRawAtRead, id); } catch (e) {
      console.error('[EDIT-ISSUE][SHARD] ' + e.message); process.exit(3);
    }
  } else {
    prev = null;
  }
} else {
  prev = root.issues[id] || null;
}

// --fields-json <path>：从 UTF-8 JSON 文件精确回填字段（含反斜杠/长文本时免命令行转义）
let patchFields = null;
if (fieldsJson !== undefined) {
  if (!fieldsJson) {
    console.error('[EDIT-ISSUE] --fields-json 需要跟一个 JSON 文件路径');
    process.exit(2);
  }
  if (!existsSync(fieldsJson)) {
    console.error('[EDIT-ISSUE] --fields-json 文件不存在: ' + resolve(fieldsJson));
    process.exit(2);
  }
  try {
    patchFields = JSON.parse(readFileSync(fieldsJson, 'utf8'));
  } catch (e) {
    console.error('[EDIT-ISSUE] --fields-json 不是合法 JSON: ' + e.message);
    process.exit(2);
  }
  if (!patchFields || typeof patchFields !== 'object' || Array.isArray(patchFields)) {
    console.error('[EDIT-ISSUE] --fields-json 必须是 JSON 对象');
    process.exit(2);
  }
  const allowedFields = new Set(['title','description','type','status','owner','branch','verifier','files','evidence',
    'evidence_level','stage','stage_results','task_card','fix_rounds']);
  for (const key of Object.keys(patchFields)) {
    if (!allowedFields.has(key)) {
      console.error('[EDIT-ISSUE] --fields-json 不允许的字段: ' + key + '（允许: ' + [...allowedFields].join(', ') + '）');
      process.exit(2);
    }
  }
  if (patchFields.type && !validTypes.has(patchFields.type)) {
    console.error('[EDIT-ISSUE] --fields-json.type 必须是: ' + [...validTypes].join(', '));
    process.exit(2);
  }
  if (patchFields.status && !validStatuses.has(patchFields.status)) {
    console.error('[EDIT-ISSUE] --fields-json.status 必须是: ' + [...validStatuses].join(', '));
    process.exit(2);
  }
}
const hasField = (key) => patchFields !== null && Object.prototype.hasOwnProperty.call(patchFields, key);
const effStatus = hasField('status') ? patchFields.status : (status ?? (prev ? prev.status : 'claimed'));
const effType = hasField('type') ? patchFields.type : (type ?? (prev ? prev.type : 'fix'));
const effOwner = hasField('owner') ? patchFields.owner : (owner ?? (prev ? prev.owner : 'cline'));
const effBranch = hasField('branch') ? patchFields.branch : (branch ?? (prev ? prev.branch : 'main'));
const effVerifier = hasField('verifier') ? patchFields.verifier : (verifier !== undefined ? verifier : (prev ? prev.verifier : null));
const { claimed_at, in_progress_at, done_at } = timestampsFor(effStatus, prev);
const effFiles = (hasField('files') && Array.isArray(patchFields.files) && patchFields.files.length) ? patchFields.files
  : (files.length ? files : (prev ? prev.files : []));
const effDescription = hasField('description') ? patchFields.description : (description !== undefined ? description : (prev ? prev.description : ''));
const effTitle = hasField('title') ? patchFields.title : (title !== undefined ? title : (prev ? prev.title : ''));

// T-171：任务卡字段（证据分级 / 阶段语义 / OUT_OF_SCOPE / 修正轮次）
// 取值优先级：命令行参数 > --fields-json > 台账既有值；校验失败显式报错，不静默兜底。
function parseJsonArg(raw, label) {
  if (raw === null || raw === undefined) return undefined;
  const text = String(raw);
  if (extname(text) === '.json' && existsSync(resolve(text))) {
    try { return JSON.parse(readFileSync(resolve(text), 'utf8')); } catch (e) {
      console.error('[EDIT-ISSUE] ' + label + ' 文件不是合法 JSON: ' + e.message);
      process.exit(2);
    }
  }
  try { return JSON.parse(text); } catch (e) {
    console.error('[EDIT-ISSUE] ' + label + ' 不是合法 JSON（可传 JSON 文本或 .json 文件路径）: ' + e.message);
    process.exit(2);
  }
}
function pickValue(field, cliValue) {
  if (hasField(field)) return patchFields[field];
  if (cliValue !== undefined) {
    if (cliValue === null) {
      console.error('[EDIT-ISSUE] --' + field.replace(/_/g, '-') + ' 缺少取值');
      process.exit(2);
    }
    return cliValue;
  }
  return prev ? prev[field] : undefined;
}
let effEvidenceLevel;
let effStage;
let effStageResults;
let effTaskCard;
let effFixRounds;
try {
  effEvidenceLevel = normalizeEvidenceLevel(pickValue('evidence_level', evidenceLevelArg));
  effStage = normalizeStage(pickValue('stage', stageArg));
  effStageResults = normalizeStageResults(pickValue('stage_results', parseJsonArg(stageResultsArg, '--stage-results')));
  effTaskCard = normalizeTaskCard(pickValue('task_card', parseJsonArg(taskCardArg, '--task-card')));
  effFixRounds = normalizeFixRounds(pickValue('fix_rounds', fixRoundsArg));
} catch (e) {
  console.error('[EDIT-ISSUE] 任务卡字段校验失败: ' + e.message);
  process.exit(2);
}

let effEvidence = prev && prev.evidence && typeof prev.evidence === 'object' ? { ...prev.evidence } : {};
if (evidenceJson) {
  let patch;
  try {
    patch = JSON.parse(evidenceJson);
  } catch (e) {
    console.error('[EDIT-ISSUE] --evidence 不是合法 JSON: ' + e.message);
    process.exit(2);
  }
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    console.error('[EDIT-ISSUE] --evidence 必须是 JSON 对象');
    process.exit(2);
  }
  Object.assign(effEvidence, patch);
}
if (hasField('evidence')) {
  if (!patchFields.evidence || typeof patchFields.evidence !== 'object' || Array.isArray(patchFields.evidence)) {
    console.error('[EDIT-ISSUE] --fields-json.evidence 必须是 JSON 对象');
    process.exit(2);
  }
  Object.assign(effEvidence, patchFields.evidence);
}

let effCV = prev && prev.cross_validation && typeof prev.cross_validation === 'object'
  ? { ...prev.cross_validation }
  : { required_by: 'M2', status: 'pending', verifier: null, evidence: '' };
if (cvStatus != null) effCV.status = cvStatus;
if (cvVerifier != null) effCV.verifier = cvVerifier;
if (cvEvidence != null) effCV.evidence = cvEvidence;

// T-258：cv 真伪闸——cv.status==='pass' 且本次触碰 cv/状态字段时，证据须是非作者客户端的原始输出
function cvGateFail(msg) {
  console.error('[EDIT-ISSUE][CV-GATE] 拒绝: ' + msg);
  process.exit(1);
}
function cvEvidenceAuthentic(evPath, owner, verifier) {
  const abs = resolve(process.cwd(), evPath);
  if (!existsSync(abs)) cvGateFail('cv 证据文件不存在: ' + evPath);
  let st;
  try { st = statSync(abs); } catch { cvGateFail('cv 证据文件不可读: ' + evPath); return; }
  if (!st.isFile()) return;
  // T-258：cv 证据（交叉验证信任锚）不得入库于 tmp/（会话结束清理后腐烂为悬空指针）
  const cvTmpAbs = resolve(process.cwd(), 'tmp');
  if (abs === cvTmpAbs || abs.startsWith(cvTmpAbs + '\\') || abs.startsWith(cvTmpAbs + '/')) {
    cvGateFail('cv 证据不得入库于 tmp/（会腐烂为悬空指针，请迁移 archive/evidence）：' + evPath);
  }
  const text = readFileSync(abs, 'utf8');
  const head = text.slice(0, 8000);
  const hdrLines = [];
  for (const ln of head.split(/\r?\n/)) { if (/^# /.test(ln)) hdrLines.push(ln); else break; }
  const headerBlock = hdrLines.join('\n');
  const hasReceipt = headerBlock !== ''
    && /# client=/.test(headerBlock)
    && /# code=0/.test(headerBlock)
    && /# timedOut=false/.test(headerBlock)
    && /# prompt_sha256=/.test(headerBlock);
  const hasVerdictLine = /VERDICT\s*[:：]\s*/.test(text);
  if (!hasReceipt && !hasVerdictLine) {
    cvGateFail('cv 证据缺 headless 收据头（# client= / # code=0 / # timedOut=false / # prompt_sha256=）且全文无 VERDICT 判定行，无法作为非作者客户端原始输出: ' + evPath);
  }
  if (!verifier || String(verifier).trim() === '') cvGateFail('cv=pass 须指定 cv-verifier（非作者客户端）: ' + evPath);
  if (String(verifier).toLowerCase() === String(owner || '').toLowerCase()) {
    cvGateFail('cv-verifier 与 owner 相同（自评 cv 禁止入库）：owner=' + owner + ' verifier=' + verifier);
  }

  // T-258 收据外锚读侧：有 headless 收据头时，文件实算与账本锚必须一致（篡改即拒）；未锚定仅警告（账本剪除正常）
  const vr = verifyReceipt(evPath);
  if (vr.status === 'MISMATCH') cvGateFail('cv 证据收据锚失效（文件已被篡改或与账本不符）：' + vr.reason);
  if (vr.status === 'NOT-ANCHORED') console.warn('[CV-GATE][WARN] ' + vr.reason + '：' + evPath);
}

// T-171 一致性：cv=pass 必须配 evidence_level=firsthand（写盘时兑现，不只查 CLI）
const touchingCv = cvStatus != null || cvVerifier != null || cvEvidence != null || (status != null && prev && prev.status !== effStatus);
if (touchingCv && effCV.status === 'pass') {
  cvEvidenceAuthentic(effCV.evidence, effOwner, effCV.verifier);
  if (effEvidenceLevel !== 'firsthand') {
    cvGateFail('cv=pass 须配 evidence_level=firsthand，当前=' + String(effEvidenceLevel));
  }
}

// T-240 证据闸（Kilo 中断分析④，2026-10-30）：本次 --evidence/--cv-evidence/--fields-json.evidence
// 引用的路径必须真实存在，且 headless 证据不得是失败运行（timedOut=true / code!=0 / dol RED）
// —— 治 T-226 式「台账 done 但引用的证据实为超时空输出」伪通过。只查本次新引用值，不追溯旧键。
function evidenceGateFail(msg) {
  console.error('[EDIT-ISSUE][EVIDENCE-GATE] 拒绝: ' + msg);
  process.exit(1);
}
function isPathLike(v) {
  return typeof v === 'string' && v.length > 0
    && (v.includes('/') || v.includes('\\'))
    && !/^https?:\/\//i.test(v);
}
function checkEvidencePath(p) {
  const abs = resolve(process.cwd(), p);
  if (!existsSync(abs)) evidenceGateFail('证据文件不存在: ' + p);
  let st;
  try { st = statSync(abs); } catch { evidenceGateFail('证据文件不可读: ' + p); return; }
  if (!st.isFile()) return; // 目录只验存在
  const head = readFileSync(abs, 'utf8').slice(0, 8000);
  // 只扫文件头连续 `# ` 元数据行（headless 头恒在首行起）；
  // 文档正文引用 `# timedOut=true` 等示例文本不算证据头（正例自测抓过全文扫误伤）。
  const hdrLines = [];
  for (const ln of head.split(/\r?\n/)) {
    if (/^# /.test(ln)) hdrLines.push(ln);
    else break;
  }
  const headerBlock = hdrLines.join('\n');
  if (!headerBlock) return; // 非 headless 头格式 → 只验存在
  if (/# timedOut=true/i.test(headerBlock)) evidenceGateFail('证据是超时失败运行(timedOut=true)，不算有效证据: ' + p);
  const m = headerBlock.match(/# code=(-?\d+)/);
  if (m && m[1] !== '0') evidenceGateFail('证据客户端退出码非 0(code=' + m[1] + ')，不算有效证据: ' + p);
  if (/# dol_verdict=(RED|INVALID)/.test(headerBlock)) evidenceGateFail('证据 DOL 判 RED/INVALID（无认领或零证据，T-419 裁决 E）: ' + p);
}
const gateVals = [];
if (evidenceJson) {
  try {
    const patchAgain = JSON.parse(evidenceJson);
    for (const v of Object.values(patchAgain || {})) if (isPathLike(v)) gateVals.push(v);
  } catch { /* 参数错误已在上方处理并退出 */ }
}
if (hasField('evidence') && patchFields.evidence && typeof patchFields.evidence === 'object') {
  for (const v of Object.values(patchFields.evidence)) if (isPathLike(v)) gateVals.push(v);
}
if (isPathLike(cvEvidence)) gateVals.push(cvEvidence);
for (const p of gateVals) checkEvidencePath(p);

const entry = {
  id,
  title: effTitle,
  type: effType,
  status: effStatus,
  owner: effOwner,
  claimed_at,
  in_progress_at,
  done_at,
  verifier: effVerifier,
  branch: effBranch,
  description: effDescription,
  files: effFiles,
  evidence: effEvidence,
  cross_validation: effCV,
  // T-171：任务卡字段（证据分级 / 阶段语义 / OUT_OF_SCOPE / 修正轮次）
  evidence_level: effEvidenceLevel,
  stage: effStage,
  stage_results: effStageResults,
  task_card: effTaskCard,
  fix_rounds: effFixRounds,
};

// T-264 规则③（用户 m05045 批定）：新开承接单必须写明「前单为什么没落地」，否则拒绝开单。
const FOLLOWUP_RE = /承接|修复前单|复发|重开|继续\s*T-|follow[- ]?up/i;
const REASON_RE = /前单未落地原因[:：]|前单为什么没落地[:：]/;
const isNewEntry = shardedMode ? prev === null : !root.issues[id];
if (isNewEntry) {
  const desc = String(effDescription || '');
  const title = String(effTitle || '');
  if ((FOLLOWUP_RE.test(title) || FOLLOWUP_RE.test(desc)) && !REASON_RE.test(desc)) {
    console.error('[EDIT-ISSUE][FOLLOWUP-GATE] 拒绝: 该单命中承接语义（承接/修复前单/复发/重开/继续T-），'
      + '但 description 未写「前单未落地原因：<为什么上一单没真落地>」。规则要求承接单必须先解释前单失效原因，否则拒绝开单。');
    process.exit(3);
  }
}

if (!isNewEntry) {
  console.log('[EDIT-ISSUE] 更新已有条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
} else {
  console.log('[EDIT-ISSUE] 新建条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
}
// T-327：条目级 patch 落盘——只替换目标条目的字节段（非目标条目字节不变），
// 失败一律拒绝覆盖（fail-closed），绝不回退为整文件重排。
// 方向 2：前置版本冲突检查（OCC）——写入前核对工作树文件是否与首次读取时一致
// 若他端已改动（无论是否已提交），拒绝基于过期版本覆盖，防止丢失他人改动。
// T-352（分片模式）：OCC 基点改为【目标分片】字节对比——他端对别的条目的并发写不再误伤本端；
//   快照侧由 git-aware 聚合天然免疫（聚合只读 HEAD + 本次目标分片）。
if (shardedMode) {
  let currentShard = null;
  try {
    currentShard = (shardAbs && existsSync(shardAbs)) ? readFileSync(shardAbs, 'utf8') : null;
  } catch (e) {
    console.error('[EDIT-ISSUE] 前置版本检查：无法再次读取分片: ' + e.message); process.exit(1);
  }
  if (currentShard !== shardRawAtRead) {
    console.error('[EDIT-ISSUE] 前置版本冲突：分片 ' + shardAbs + ' 已与首次读取时不同（他端已写入未结账）。拒绝基于过期版本覆盖。');
    console.error('[EDIT-ISSUE] 处理：先 git pull/rebase 同步他端提交，或让他端 owner 先结账，再重新认领本条目。');
    process.exit(1);
  }
} else {
  let currentRaw;
  try {
    currentRaw = readFileSync(registry, 'utf8');
  } catch (e) {
    console.error('[EDIT-ISSUE] 前置版本检查：无法再次读取注册表: ' + e.message); process.exit(1);
  }
  if (currentRaw !== raw) {
    console.error('[EDIT-ISSUE] 前置版本冲突：工作树 ' + resolve(registry) + ' 已与首次读取时不同（他端已改动未结账）。拒绝基于过期版本覆盖。');
    console.error('[EDIT-ISSUE] 处理：先 git pull/rebase 同步他端提交，或让他端 owner 先提交结账，再重新认领本条目。');
    process.exit(1);
  }
}

// T-352：分片模式——内容全部在内存中算好，一次提案三文件（快照 / 分片 / _meta），fail 前不写盘。
// legacy 模式保持原有 entry-scoped patch 行为（非目标条目字节零变更）。
let out;
let snapshotContent = null;
let metaContent = null;
let aggInfo = null;
if (shardedMode) {
  out = JSON.stringify(entry, null, 2) + '\n';
  try {
    const shardCheck = JSON.parse(out);
    if (!shardCheck || String(shardCheck.id) !== String(id)) {
      console.error('[EDIT-ISSUE] 生成内容自校验失败（id 缺失/不一致）'); process.exit(3);
    }
  } catch (e) {
    console.error('[EDIT-ISSUE] 生成内容 JSON 不可解析（内部错误）: ' + e.message); process.exit(3);
  }
  try {
    // targetRaw 直传：聚合不依赖磁盘旧分片（避免先写后聚合的半成品窗口；失败时三文件都不落盘）
    aggInfo = aggregateGitAware({ repoRoot: process.cwd(), registryPath: registryAbs, targetId: id, targetRaw: out });
    snapshotContent = aggInfo.serialized;
    metaContent = metaPayload(aggInfo.count, aggInfo.sha256);
  } catch (e) {
    console.error('[EDIT-ISSUE] 快照聚合失败（未写盘）: ' + String((e && e.message) || e));
    process.exit(3);
  }
} else {
  try {
    out = patchOrInsertEntry(raw, id, entry);
    assertNonTargetPreserved(raw, out, id);
  } catch (e) {
    console.error('[EDIT-ISSUE] 条目级落盘失败（拒绝覆盖，未写盘）: ' + String((e && e.message) || e));
    process.exit(3);
  }
  // 回写前再次校验（防御性）
  let check;
  try { check = JSON.parse(out); } catch (e) {
    console.error('[EDIT-ISSUE] 生成内容 JSON 不可解析（内部错误）: ' + e.message); process.exit(3);
  }
  if (!check.issues[id]) { console.error('[EDIT-ISSUE] 写回后条目缺失（内部错误）'); process.exit(3); }
}

// T-153：台账属高风险目标，写入改走「提案 → diff → 确认 → 落盘」闸。
// 默认 attested 确认（调用方署名 --by，diff 摘要同步打印并入账本）；
// --defer 则只提案不落盘，等显式确认（node orchestrator/run-gate.mjs confirm/apply）后再写。
const metaAbs = shardedMode ? join(shardDirAbs, SHARD_META) : null;
const cls = classifyTarget(registry, { repoRoot: process.cwd() });
const shardCls = shardedMode ? classifyTarget(shardAbs, { repoRoot: process.cwd() }) : { category: 'normal', rule: '普通文件' };
const proposalTargets = shardedMode
  ? [{ path: registryAbs, content: snapshotContent }, { path: shardAbs, content: out }, { path: metaAbs, content: metaContent }]
  : [{ path: resolve(registry), content: out }];
if (isHighRisk(cls.category) || isHighRisk(shardCls.category)) {
  const reason = gateReason || ('edit-issue ' + id + ' -> ' + effStatus);
  const proposal = gate.createProposal({
    kind: 'write',
    actor,
    reason,
    note: 'edit-issue ' + id,
    targets: proposalTargets,
    confirmed: deferGate ? null : { by: actor, reason },
  });
  const sum = gate.summarize(proposal);
  console.log('[EDIT-ISSUE] [GATE] proposal=' + proposal.id + ' category=' + cls.category + (shardedMode ? '+' + shardCls.category : '') + ' rule=' + cls.rule +
    ' files=' + sum.files.length + ' +' + sum.added + ' -' + sum.removed + ' confirm_mode=' + proposal.confirm_mode);
  if (deferGate) {
    console.log('[EDIT-ISSUE] 提案已登记，未落盘（--defer）。下一步：');
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs diff --proposal ' + proposal.id);
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs confirm --proposal ' + proposal.id + ' --by ' + actor);
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs apply --proposal ' + proposal.id);
  } else {
    gate.applyProposal(proposal.id, { by: actor });
    console.log('[EDIT-ISSUE] [GATE] 已确认并落盘: ' + proposal.id + (shardedMode ? '（分片 + 快照 + _meta 三文件）' : ''));
  }
} else {
  for (const t of proposalTargets) {
    try { atomicWriteFileSync(t.path, t.content); } catch (e) {
      console.error('[EDIT-ISSUE] 写回失败: ' + t.path + ' -> ' + e.message); process.exit(1);
    }
  }
}
console.log('[EDIT-ISSUE] 已写入条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
if (shardedMode) {
  console.log('[EDIT-ISSUE] 已写入分片: ' + shardAbs);
  console.log('[EDIT-ISSUE] 快照已 git-aware 重聚合（共 ' + aggInfo.count + ' 条，sha256=' + aggInfo.sha256.slice(0, 16) + '…）: ' + registryAbs); // vaw-ok（现有行，CJK 孤立字报警误报；verify-gate 不改）
}
console.log('[EDIT-ISSUE] 文件: ' + resolve(registry));
console.log('[EDIT-ISSUE] JSON 校验通过，可安全提交');
try {
  writeClaimManifest([id], process.cwd());
  console.log('[EDIT-ISSUE] claim-manifest 已更新（台账混合 diff 闸输入）: tmp/.claim-manifest.json');
} catch (e) {
  console.error('[EDIT-ISSUE] claim-manifest 写入失败（提交会被台账混合 diff 闸 fail-closed 拦截）: ' + e.message);
}

// 方向 2：认领即提交 —— 写入成功后若 --auto-commit，自动 git add + git commit，
// 不留未提交台账 diff 悬挂在工作树，避免被 mixed-diff-gate/claim-gate 拦截。
if (autoCommit) {
  const commitMsg = '[' + id + '] ' + effType + ': ' + effTitle;
  const commitEnv = { ...process.env, TITAN_EDIT_ISSUE_AUTO_COMMIT: '1' };
  const addTargets = shardedMode ? [resolve(registry), shardAbs, metaAbs] : [resolve(registry)];
  const addR = spawnSync('git', ['add', ...addTargets], { encoding: 'utf8', env: commitEnv });
  if (addR.status !== 0) {
    console.error('[EDIT-ISSUE] 自动提交：git add 失败 -> ' + String(addR.stderr || addR.error || addR.stdout));
    process.exit(1);
  }
  const commitR = spawnSync('git', ['commit', '-m', commitMsg], { encoding: 'utf8', env: commitEnv });
  if (commitR.status !== 0) {
    console.error('[EDIT-ISSUE] 自动提交：git commit 失败 -> ' + String(commitR.stderr || commitR.error || commitR.stdout));
    process.exit(1);
  }
  console.log('[EDIT-ISSUE] 自动提交已完成: ' + commitMsg);
  console.log((commitR.stdout || '').trim());
}
