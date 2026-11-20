// orchestrator/lib/task-card.mjs — T-171 任务卡 schema（证据分级 / 一次修正后停止 / OUT_OF_SCOPE / 阶段语义 / YAML 任务卡）
//
// 定位：把 EP07 复盘挑出来的 4 条纪律 + 我们自己缺的一条，变成**台账里可校验的字段**，而不是文档里的一句话：
//   1. 证据分级     —— 台账区分「亲验 / 本地自报 / 未验证」，不再只有 verifier 一个字段；
//   2. 一次修正后停止 —— 作者修正轮次超过 1 就必须移交他人（作者不许自己反复改到过）；
//   3. OUT_OF_SCOPE —— 任务卡显式写禁止事项，命中即停手回报；
//   4. 阶段语义     —— 代码 / 产物 / 发布三段**独立** PASS，代码过了不等于产物过了；
//   5. YAML 任务卡  —— 任务卡可渲染成 YAML 供委派 prompt / 工作单复用（零依赖最小子集解析）。
//
// 与既有口径的关系（别混）：
//   - 本模块的 evidence_level = **验证强度**（firsthand / local_report / unverified）；
//     orchestrator/lib/pipeline-stage.mjs 的 evidenceLevel = **产物是否真实产出**（real / local-placeholder / pending）。
//     两条轴正交：一份 real 产物也可能只有 local_report 级的验证。
//   - 本模块的 stage = **交付阶段**（code / artifact / release），与 pipeline-stage 的 design/plan/implement/deliver 不同源。
//
// 红线：
//   1. 零依赖（只用 node: 内置），不改 ISSUE_REGISTRY.json 的既有字段语义，只**追加**可选字段。
//   2. 校验失败一律显式抛错 / 显式报 issue，不静默兜底成"通过"。
//   3. 本模块不写文件（渲染/解析都在内存）；落盘由调用方（edit-issue.mjs）负责并走高风险写闸。

export const EVIDENCE_LEVELS = Object.freeze(['firsthand', 'local_report', 'unverified']);
export const EVIDENCE_LEVEL_LABELS = Object.freeze({
  firsthand: '云端/独立客户端亲验',
  local_report: '本地执行端自报（作者自跑，未被第二方复核）',
  unverified: '未验证',
});
// T-255：dol-scanner 内部三档证据分级 → 台账 evidence_level 三值映射（唯一正表，
// 三处共用：dol 扫描 / 台账 / 技能，勿另造第二套分级词汇）。
export const DOL_GRADE_TO_EVIDENCE_LEVEL = Object.freeze({
  VERIFIED: 'firsthand',
  REFERENCED: 'local_report',
  UNVERIFIED: 'unverified',
});
export const STAGES = Object.freeze(['code', 'artifact', 'release']);
export const STAGE_LABELS = Object.freeze({
  code: '代码段（代码 → 审查 → 修复 → 验证）',
  artifact: '产物段（构建/打包/产物完整性）',
  release: '发布段（可获取性/发布验收）',
});
export const STAGE_RESULTS = Object.freeze(['PASS', 'FAIL', 'UNKNOWN']);
export const TASK_CARD_FIELDS = Object.freeze(['scope', 'acceptance', 'out_of_scope', 'evidence_required']);
// 一次修正后停止：作者自己改到第 2 轮还没过，就必须换人（作者 ≠ 验证者）
export const MAX_FIX_ROUNDS = 1;

function asStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error('任务卡字段 ' + field + ' 必须是数组');
  return value.map((v) => {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    throw new Error('任务卡字段 ' + field + ' 只能含字符串/数字/布尔');
  });
}

export function normalizeEvidenceLevel(value, { fallback = 'unverified' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (!EVIDENCE_LEVELS.includes(v)) {
    throw new Error('非法 evidence_level: ' + value + '（允许: ' + EVIDENCE_LEVELS.join(' / ') + '）');
  }
  return v;
}

export function normalizeStage(value, { fallback = 'code' } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const v = String(value).trim().toLowerCase();
  if (!STAGES.includes(v)) {
    throw new Error('非法 stage: ' + value + '（允许: ' + STAGES.join(' / ') + '）');
  }
  return v;
}

export function normalizeStageResults(value) {
  const out = { code: null, artifact: null, release: null };
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('stage_results 必须是对象');
  for (const key of Object.keys(value)) {
    if (!STAGES.includes(key)) throw new Error('stage_results 含未知阶段: ' + key + '（允许: ' + STAGES.join(' / ') + '）');
    const raw = value[key];
    if (raw === null || raw === undefined || raw === '') { out[key] = null; continue; }
    const v = String(raw).trim().toUpperCase();
    if (!STAGE_RESULTS.includes(v)) {
      throw new Error('非法 stage_results.' + key + ': ' + raw + '（允许: ' + STAGE_RESULTS.join(' / ') + ' 或留空）');
    }
    out[key] = v;
  }
  return out;
}

export function normalizeTaskCard(value) {
  const out = { scope: [], acceptance: [], out_of_scope: [], evidence_required: [] };
  if (value === undefined || value === null) return out;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('task_card 必须是对象');
  for (const key of Object.keys(value)) {
    if (!TASK_CARD_FIELDS.includes(key)) {
      throw new Error('task_card 含未知字段: ' + key + '（允许: ' + TASK_CARD_FIELDS.join(' / ') + '）');
    }
    out[key] = asStringArray(value[key], key);
  }
  return out;
}

export function normalizeFixRounds(value, { fallback = 0 } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error('非法 fix_rounds: ' + value + '（必须是非负整数）');
  return n;
}

// 纪律校验：一条台账条目是否满足「证据分级 / 一次修正后停止 / 阶段语义」
export function evaluateEntry(entry) {
  const issues = [];
  const warnings = [];
  const e = entry && typeof entry === 'object' ? entry : {};

  let evidenceLevel = 'unverified';
  try {
    evidenceLevel = normalizeEvidenceLevel(e.evidence_level, { fallback: 'unverified' });
  } catch (err) {
    issues.push('evidence_level 非法: ' + err.message);
  }

  let stageResults = { code: null, artifact: null, release: null };
  try {
    stageResults = normalizeStageResults(e.stage_results);
  } catch (err) {
    issues.push('stage_results 非法: ' + err.message);
  }

  let taskCard = { scope: [], acceptance: [], out_of_scope: [], evidence_required: [] };
  try {
    taskCard = normalizeTaskCard(e.task_card);
  } catch (err) {
    issues.push('task_card 非法: ' + err.message);
  }

  let fixRounds = 0;
  try {
    fixRounds = normalizeFixRounds(e.fix_rounds);
  } catch (err) {
    issues.push('fix_rounds 非法: ' + err.message);
  }

  const status = String(e.status || '').trim();
  const owner = String(e.owner || '').trim();
  const cv = (e.cross_validation && typeof e.cross_validation === 'object') ? e.cross_validation : {};
  // 区分「显式写了」与「历史条目缺省」：缺省只警告（待补分级），显式写错才报 issue
  const hasEvidenceLevel = typeof e.evidence_level === 'string' && e.evidence_level.trim() !== '';
  const hasStageResults = !!(e.stage_results && typeof e.stage_results === 'object' && Object.keys(e.stage_results).length > 0);
  const hasTaskCard = !!(e.task_card && typeof e.task_card === 'object' && Object.keys(e.task_card).length > 0);

  // 阶段语义：代码不过则产物/发布不可能过；产物过了发布段仍要单独判
  if (stageResults.artifact === 'PASS' && stageResults.code !== 'PASS') {
    issues.push('阶段语义矛盾: 产物段 PASS 但代码段不是 PASS');
  }
  if (stageResults.release === 'PASS' && stageResults.artifact !== 'PASS') {
    issues.push('阶段语义矛盾: 发布段 PASS 但产物段不是 PASS');
  }
  if (status === 'done') {
    if (!hasStageResults) {
      warnings.push('done 但未记录 stage_results（历史条目待补阶段分级）');
    } else if (stageResults.code !== 'PASS') {
      issues.push('状态 done 但代码段不是 PASS（代码通过 ≠ 任务完成）');
    }
    if (stageResults.artifact === 'FAIL') issues.push('状态 done 但产物段 FAIL');
    if (stageResults.release === 'FAIL') issues.push('状态 done 但发布段 FAIL');
    if (!hasTaskCard) {
      warnings.push('done 但没有 task_card（验收标准 / 禁止事项缺失，历史条目待补）');
    } else if (!taskCard.acceptance.length) {
      warnings.push('done 但任务卡没有 acceptance 条目（验收标准缺失）');
    }
  }

  // 证据分级：交叉验证标 PASS 的，验证强度必须真的是亲验
  if (String(cv.status || '').toUpperCase() === 'PASS' && evidenceLevel !== 'firsthand') {
    if (hasEvidenceLevel) {
      issues.push('交叉验证标 PASS 但 evidence_level 不是 firsthand（亲验与自报不可混）');
    } else {
      warnings.push('交叉验证标 PASS 但 evidence_level 未分级（历史条目待补）');
    }
  }
  if (String(cv.status || '').toUpperCase() === 'FAIL') {
    issues.push('交叉验证 FAIL：' + (cv.evidence || '（未填证据）'));
  }

  // 一次修正后停止：作者改了超过 1 轮还没过 → 必须移交他人
  if (fixRounds > MAX_FIX_ROUNDS) {
    const verifier = String(cv.verifier || '').trim();
    const escalated = verifier && verifier !== owner;
    if (!escalated) {
      issues.push('修正轮次 ' + fixRounds + ' > ' + MAX_FIX_ROUNDS + '，必须移交他人复核（verifier 与 owner 不同）');
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    evidence_level: evidenceLevel,
    stage_results: stageResults,
    task_card: taskCard,
    fix_rounds: fixRounds,
  };
}

function yamlQuote(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ') + '"';
}

function yamlUnquote(raw) {
  const v = String(raw).trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return v;
}

// 渲染成 YAML 任务卡（委派 prompt / 工作单可直接复用）
export function renderTaskCardYaml(entry, { taskCard = null } = {}) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const card = taskCard ? normalizeTaskCard(taskCard) : normalizeTaskCard(e.task_card);
  const evidenceLevel = normalizeEvidenceLevel(e.evidence_level, { fallback: 'unverified' });
  const stage = normalizeStage(e.stage, { fallback: 'code' });
  const stageResults = normalizeStageResults(e.stage_results);
  const fixRounds = normalizeFixRounds(e.fix_rounds);
  const lines = [];
  lines.push('# 任务卡（T-171 标准格式；scope=范围 / acceptance=验收 / out_of_scope=禁止事项 / evidence_required=证据要求）');
  lines.push('id: ' + yamlQuote(e.id || ''));
  lines.push('title: ' + yamlQuote(e.title || ''));
  lines.push('owner: ' + yamlQuote(e.owner || 'unassigned'));
  lines.push('status: ' + yamlQuote(e.status || 'todo'));
  lines.push('evidence_level: ' + yamlQuote(evidenceLevel));
  lines.push('stage: ' + yamlQuote(stage));
  lines.push('fix_rounds: ' + fixRounds);
  lines.push('stage_results:');
  for (const s of STAGES) lines.push('  ' + s + ': ' + (stageResults[s] === null ? 'null' : stageResults[s]));
  for (const field of TASK_CARD_FIELDS) {
    lines.push(field + ':');
    if (!card[field].length) lines.push('  []');
    for (const item of card[field]) lines.push('  - ' + yamlQuote(item));
  }
  return lines.join('\n') + '\n';
}

// 解析 YAML 任务卡（零依赖最小子集：仅本模块渲染出的结构）
export function parseTaskCardYaml(text) {
  const src = String(text || '');
  const out = { scope: [], acceptance: [], out_of_scope: [], evidence_required: [] };
  const scalars = {};
  let currentList = null;
  for (const rawLine of src.split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim()) continue;
    if (line.trim().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s+(.*)$/);
    if (listItem && currentList) {
      out[currentList].push(yamlUnquote(listItem[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (TASK_CARD_FIELDS.includes(key)) {
      if (!value) { currentList = key; continue; }
      if (value === '[]') { currentList = null; continue; }
      currentList = key;
      out[key].push(yamlUnquote(value));
      continue;
    }
    if (key === 'stage_results') { currentList = null; continue; }
    currentList = null;
    if (value === '') continue;
    scalars[key] = yamlUnquote(value);
  }
  return { ...scalars, ...out };
}

export function summarizeEntry(entry) {
  const e = entry && typeof entry === 'object' ? entry : {};
  const ev = evaluateEntry(e);
  const sr = ev.stage_results;
  return [
    e.id || '?',
    'status=' + (e.status || '?'),
    'owner=' + (e.owner || '?'),
    'evidence=' + ev.evidence_level,
    'stage=' + sr.code + '/' + sr.artifact + '/' + sr.release,
    'fix_rounds=' + ev.fix_rounds,
    ev.ok ? 'OK' : 'ISSUES=' + ev.issues.length,
  ].join(' ');
}

export default {
  EVIDENCE_LEVELS, EVIDENCE_LEVEL_LABELS, DOL_GRADE_TO_EVIDENCE_LEVEL, STAGES, STAGE_LABELS, STAGE_RESULTS,
  TASK_CARD_FIELDS, MAX_FIX_ROUNDS,
  normalizeEvidenceLevel, normalizeStage, normalizeStageResults, normalizeTaskCard, normalizeFixRounds,
  evaluateEntry, renderTaskCardYaml, parseTaskCardYaml, summarizeEntry,
};
