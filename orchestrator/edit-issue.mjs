#!/usr/bin/env node
// edit-issue.mjs —— ISSUE_REGISTRY.json 条目自动编辑模板（P0）
// 用途：输入 id/title/type/status/owner/description/files 等字段，自动完成
//   JSON 转义、逗号插入、括号闭合、时间戳填充，生成可直接合并的条目，
//   消除手工拼接 JSON 导致的语法错误（trailing comma、括号不匹配、重复条目等）。
// 用法示例：
//   node orchestrator/edit-issue.mjs --id T-131 --title "xxx" --type fix --status claimed --owner cline --description "xxx" --files ISSUE_REGISTRY.json --files design-specs/x.md
// 退出码：0=成功，1=运行时错误，2=参数错误，3=JSON 校验失败
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { gate, classifyTarget, isHighRisk } from './lib/write-gate.mjs';
import {
  normalizeEvidenceLevel, normalizeStage, normalizeStageResults, normalizeTaskCard, normalizeFixRounds,
} from './lib/task-card.mjs';

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
const nowBeijing = () => {
  const d = new Date();
  const off = d.getTimezoneOffset(); // 分钟，北京 = -480
  const localMs = d.getTime() - off * 60000;
  const ld = new Date(localMs);
  const pad = (n) => String(n).padStart(2, '0');
  const tz = off <= 0 ? '+' : '-';
  const tzH = pad(Math.abs(Math.trunc(off / 60)));
  const tzM = pad(Math.abs(off % 60));
  return `${ld.getFullYear()}-${pad(ld.getMonth() + 1)}-${pad(ld.getDate())}T${pad(ld.getHours())}:${pad(ld.getMinutes())}:${pad(ld.getSeconds())}${tz}${tzH}:${tzM}`;
};
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
const prev = root.issues[id] || null;

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
  if (/# dol_verdict=RED/.test(headerBlock)) evidenceGateFail('证据 DOL 判 RED(自述完成零证据): ' + p);
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

if (root.issues[id]) {
  console.log('[EDIT-ISSUE] 更新已有条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
} else {
  console.log('[EDIT-ISSUE] 新建条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
}
root.issues[id] = entry;
const out = JSON.stringify(root, null, 2) + '\n';
// 回写前再次校验（防御性）
let check;
try { check = JSON.parse(out); } catch (e) {
  console.error('[EDIT-ISSUE] 生成内容 JSON 不可解析（内部错误）: ' + e.message); process.exit(3);
}
if (!check.issues[id]) { console.error('[EDIT-ISSUE] 写回后条目缺失（内部错误）'); process.exit(3); }

// T-153：台账属高风险目标，写入改走「提案 → diff → 确认 → 落盘」闸。
// 默认 attested 确认（调用方署名 --by，diff 摘要同步打印并入账本）；
// --defer 则只提案不落盘，等显式确认（node orchestrator/run-gate.mjs confirm/apply）后再写。
const cls = classifyTarget(registry, { repoRoot: process.cwd() });
if (isHighRisk(cls.category)) {
  const reason = gateReason || ('edit-issue ' + id + ' -> ' + effStatus);
  const proposal = gate.createProposal({
    kind: 'write',
    actor,
    reason,
    note: 'edit-issue ' + id,
    targets: [{ path: resolve(registry), content: out }],
    confirmed: deferGate ? null : { by: actor, reason },
  });
  const sum = gate.summarize(proposal);
  console.log('[EDIT-ISSUE] [GATE] proposal=' + proposal.id + ' category=' + cls.category + ' rule=' + cls.rule +
    ' files=' + sum.files.length + ' +' + sum.added + ' -' + sum.removed + ' confirm_mode=' + proposal.confirm_mode);
  if (deferGate) {
    console.log('[EDIT-ISSUE] 提案已登记，未落盘（--defer）。下一步：');
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs diff --proposal ' + proposal.id);
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs confirm --proposal ' + proposal.id + ' --by ' + actor);
    console.log('[EDIT-ISSUE]   node orchestrator/run-gate.mjs apply --proposal ' + proposal.id);
  } else {
    gate.applyProposal(proposal.id, { by: actor });
    console.log('[EDIT-ISSUE] [GATE] 已确认并落盘: ' + proposal.id);
  }
} else {
  try { writeFileSync(registry, out, 'utf8'); } catch (e) {
    console.error('[EDIT-ISSUE] 写回失败: ' + e.message); process.exit(1);
  }
}
console.log('[EDIT-ISSUE] 已写入条目: ' + id + ' (status=' + effStatus + ', owner=' + effOwner + ')');
console.log('[EDIT-ISSUE] 文件: ' + resolve(registry));
console.log('[EDIT-ISSUE] JSON 校验通过，可安全提交');
