// orchestrator/lib/pipeline-runner.mjs — T-162 生命周期模式执行器（R1 实装）
//
// 四个阶段 + 串链的口径（**框架真、内容源按可用性降级**）：
//   design    需求 → stage-01-design/{requirement.md, design-brief.md, stage.json}
//   plan      stage-01 → stage-02-plan/{plan.md, work-order.json, stage.json}
//   implement stage-02 → stage-03-implement/{executor-command.txt, stage.json}（**不改业务文件**）
//   deliver   stage-03/02 → stage-04-deliver/{delivery.md, artifact-index.json, stage.json}
//   pipeline  四阶段串链：任一阶段失败即停并落 evidence.json
//
// 诚实口径：每份 stage.json 带 evidenceLevel
//   real             = 由真实链路产出（本框架里暂无；多席位会诊接入后升级）
//   local-placeholder= 本地确定性产出（模板/推导），不是模型设计
//   pending          = 需执行器/人工补做（本阶段只产出执行单）
// 不谎报完成：串链成功只代表"框架跑通"，evidence.json 里逐阶段记 evidenceLevel。
//
// 红线：
//   1. 本模块**不修改任何业务文件**——implement 阶段只写执行单（真正改码走 titan-execute）。
//   2. 阶段之间靠文件契约交接（stage.json 的 outputs/artifacts 指名下一阶段读什么）。
//   3. 失败即停：--pipeline 遇失败阶段不继续，并把失败原因写进 evidence.json。

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  STAGE_ORDER, STAGE_DIRS, createPipeline, stageDir, writeStageArtifact, readStageArtifact,
  listPipelineStages, writePipelineEvidence, latestPipeline,
} from './pipeline-stage.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
// 本地席模型 pin：审附件必须用高档（freellmapi 池里的强推理档），不能用低档/默认 auto
const LOCAL_SEAT_MODEL = process.env.TITAN_LOCAL_SEAT_MODEL || 'freellmapi/nemotron-3-ultra-550b';

function nowIso() {
  return new Date().toISOString();
}

function slug(text, max = 40) {
  return String(text || '').replace(/\s+/g, '-').slice(0, max).replace(/[^\w.-]/g, '') || 'req';
}

// ---------- design ----------
async function runDesign(pipeline, { requirement, project, real, seatChannels }) {
  const startedAt = Date.now();

  const dir = stageDir(pipeline, 'design');
  const reqFile = join(dir, 'requirement.md');
  writeFileSync(reqFile, '# 需求原文\n\n' + requirement + '\n', 'utf8');

  // T-168：真链路（多席位评审 → analyze delta → architect 裁决）
  // 默认**不跑**真链（保持既有 12 个 active 模式行为不变 + 测试不被真链拖慢）；
  // 显式加 --real 才走真链。走不通 → 显式降级 local-placeholder 并标注原因（绝不谎报 real）。
  // 评审对象 = **目标代码 + 需求简报打包成一个附件**（网页席走上传通道审附件，不是一问一答）
  const brief = buildDesignBrief(requirement, project);
  const briefFile = join(dir, 'design-brief.md');
  writeFileSync(briefFile, brief, 'utf8');
  const artifactFile = buildReviewArtifact({ brief, briefFile, targets: extractTargetFiles(requirement), dir });
  let realInfo = null;
  if (!real) {
    realInfo = { ok: false, level: 'local-placeholder', note: '未启用真链（加 --real 走多席位评审 → delta → 架构师裁决）' };
  } else try {
    const { runMultiSeatReview, buildDecisionArtifacts } = await import('./pipeline-real.mjs');
    const review = await runMultiSeatReview({
      brief, briefPath: artifactFile, outDir: dir, repoRoot: REPO_ROOT,
      seatChannels, localModel: LOCAL_SEAT_MODEL,
    });
    if (!review.ok) {
      realInfo = { ok: false, level: 'local-placeholder', note: '多席位评审无有效产出：' + (review.reasons || []).join('；').slice(0, 200) };
    } else {
      const reviewDir = join(REPO_ROOT, 'reviews', review.dispatchId);
      const art = await buildDecisionArtifacts({ dispatchId: review.dispatchId, rawDir: review.rawDir, outDir: dir, reviewDir, architectChannel: seatChannels === 'api' ? 'api' : 'web' });
      // 真产物拷进 stage-01-design（阶段契约只认自己目录里的文件）
      const copies = [];
      for (const [src, dst] of [
        [join(reviewDir, 'layer-b', 'delta.md'), 'delta.md'],
        [join(reviewDir, 'layer-b', 'architect-decision.md'), 'architect-decision.md'],
        [join(reviewDir, 'layer-a', 'issues-normalized.json'), 'issues-normalized.json'],
        [join(reviewDir, 'layer-a', 'aggregated-feedback.md'), 'aggregated-feedback.md'],
      ]) {
        if (existsSync(src)) { writeFileSync(join(dir, dst), readFileSync(src, 'utf8'), 'utf8'); copies.push(dst); }
      }
      const okSeats = review.seats.filter((s) => s.ok).map((s) => s.name + '(' + s.kind + ')');
      if (art.analyzeOk && art.architectOk) {
        realInfo = {
          ok: true, level: 'real', dispatchId: review.dispatchId, reviewDir,
          seats: okSeats, copies, delta: 'delta.md', decision: 'architect-decision.md',
        };
      } else {
        realInfo = {
          ok: false, level: 'local-placeholder', dispatchId: review.dispatchId, reviewDir,
          note: '真链路未走完（analyze=' + art.analyzeOk + ' architect=' + art.architectOk + '）' + (art.architectNote ? '：' + art.architectNote : '') + '；席位=' + okSeats.join(','),
        };
      }
    }
  } catch (e) {
    realInfo = { ok: false, level: 'local-placeholder', note: '真链路异常：' + String((e && e.message) || e).slice(0, 200) };
  }

  const artifacts = [reqFile, briefFile];
  if (realInfo && realInfo.copies) for (const c of realInfo.copies) artifacts.push(join(dir, c));
  const res = writeStageArtifact(pipeline, 'design', {
    startedAt,
    parentStageId: null,
    inputs: { requirement, project },
    outputs: {
      brief: 'design-brief.md', requirement: 'requirement.md',
      ...(realInfo && realInfo.ok ? { delta: 'delta.md', decision: 'architect-decision.md', reviewDir: realInfo.reviewDir, dispatchId: realInfo.dispatchId } : {}),
    },
    decisions: realInfo && realInfo.ok ? [{ kind: 'architect', artifact: 'architect-decision.md', seats: realInfo.seats }] : [],
    artifacts,
    evidenceLevel: realInfo && realInfo.level === 'real' ? 'real' : 'local-placeholder',
    notes: realInfo && realInfo.level === 'real'
      ? ('多席位真评审（' + (realInfo.seats || []).join(',') + '）→ delta → architect 裁决（dispatchId=' + realInfo.dispatchId + '）')
      : ((realInfo && realInfo.note) || '本地模板产出'),
  });
  return { ok: true, stage: 'design', artifact: res.artifact, dir, real: realInfo };
}

/**
 * 组装待审 artifact（网页席走**附件通道**审它，不是一问一答）：
 *   = 需求与设计简报 + 目标文件的真实内容（带行号，便于给出可定位的意见）
 * 目标文件读不到就只带简报（并在包里写明），不猜。
 */
export function buildReviewArtifact({ brief, briefFile, targets, dir }) {
  const parts = [brief, '', '## 5. 待审目标文件（真实内容，带行号）', ''];
  let included = 0;
  // 只收**文本**文件：图片类（png/jpg/…）会让部分席直接报错（"does not support image input"）
  const TEXT_EXT = /\.(mjs|js|cjs|ts|tsx|py|json|md|yaml|yml|txt|css|html|ps1|sh|sql)$/i;
  for (const t of targets) {
    const abs = isAbsolute(t) ? t : join(REPO_ROOT, t);
    if (!existsSync(abs)) { parts.push('### ' + t + '（文件不存在或不在仓库内，跳过）', ''); continue; }
    if (!TEXT_EXT.test(t)) { parts.push('### ' + t + '（非文本文件，评审通道不收）', ''); continue; }
    try {
      const content = readFileSync(abs, 'utf8');
      const lines = content.split(/\r?\n/);
      // 体积收窄到 220 行：模型答得快（实测 400 行时网页席要 113s，附件越大越慢）
      const CAP = 220;
      parts.push('### ' + t + '（' + lines.length + ' 行' + (lines.length > CAP ? '，只给前 ' + CAP + ' 行' : '') + '）', '');
      parts.push('```' + t);
      parts.push(...lines.slice(0, CAP).map((l, i) => String(i + 1).padStart(4, ' ') + ' | ' + l));
      if (lines.length > CAP) parts.push('...（截断到前 ' + CAP + ' 行）');
      parts.push('```', '');
      included += 1;
    } catch (e) {
      parts.push('### ' + t + '（读取失败：' + String((e && e.message) || e).slice(0, 60) + '）', '');
    }
  }
  if (!included) parts.push('（本次无目标文件可附，仅审需求与设计简报）', '');
  const out = join(dir, 'review-artifact.md');
  writeFileSync(out, parts.join('\n'), 'utf8');
  return out;
}

/** 从需求文本里解析目标文件（可执行落点）—— 评审对象是代码，delta 才带文件行号 */
export function extractTargetFiles(requirement) {
  const text = String(requirement || '');
  const out = [];
  const re = /([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\.[A-Za-z0-9]{1,8})/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const p = m[1];
    if (/\.(mjs|js|cjs|ts|py|json|md|yaml|yml|ps1|html|css)$/i.test(p) && !out.includes(p)) out.push(p);
  }
  return out.slice(0, 8);
}

/** 设计简报：需求原文 + 目标文件 + 仓库硬约束（真实约束来自 AGENTS.md 口径，不编造） */
function buildDesignBrief(requirement, project) {
  const targets = extractTargetFiles(requirement);
  return [
    '# 设计简报',
    '',
    '## 1. 需求',
    requirement,
    '',
    '## 2. 项目',
    project || '(未指定)',
    '',
    '## 2.1 目标文件（评审落点；请针对这些文件给出可执行意见）',
    ...(extractTargetFiles(requirement).length
      ? extractTargetFiles(requirement).map((f) => '- ' + f)
      : ['- （需求未点名文件：请就需求本身给出方案级意见）']),
    '',
    '## 3. 硬约束（仓库红线）',
    '- 宪法文件（AGENTS.md / 台账 / 发布树 / 密钥）写入必须走高风险写确认闸',
    '- 改 orchestrator/ 代码必须跑 node orchestrator/verify-gate.mjs（语法+导入+自检+体量）全绿',
    '- 可执行源码单文件 ≤ 50 KiB，超线即冻结"只减不增"',
    '- 密钥只从 env / titan_secrets.env 读，不进命令行、不进日志',
    '- 阶段之间只靠文件契约交接；implement 改码走 titan-execute（verify 前置）',
    '',
    '## 4. 交付物',
    '- 本阶段：stage-01-design/{requirement.md, design-brief.md, stage.json} + 多席位评审产物（delta.md / architect-decision.md）',
    '- 下一步：--plan 续跑本 pipeline（步骤由 delta + 架构师裁决推导）',
  ].join('\n') + '\n';
}

// ---------- plan ----------
async function runPlan(pipeline, { project }) {
  const startedAt = Date.now();

  const design = readStageArtifact(pipeline, 'design');
  const dir = stageDir(pipeline, 'plan');
  const requirement = (design && design.inputs && design.inputs.requirement) || '';
  // T-168：步骤由 design 的真 delta + 架构师裁决推导（无真产物时才回退模板表并显式标注）
  let steps = null;
  let derivation = 'template';
  let deltaText = '';
  let decisionText = '';
  if (design && design.outputs && design.outputs.delta && design.outputs.decision) {
    const dPath = join(stageDir(pipeline, 'design'), 'delta.md');
    const aPath = join(stageDir(pipeline, 'design'), 'architect-decision.md');
    if (existsSync(dPath) && existsSync(aPath)) {
      deltaText = readFileSync(dPath, 'utf8');
      decisionText = readFileSync(aPath, 'utf8');
      const { deriveStepsFromDecision } = await import('./pipeline-real.mjs');
      steps = deriveStepsFromDecision({ deltaText, decisionText, requirement, fallbackFile: extractTargetFiles(requirement)[0] || '' });
      derivation = 'delta+architect-decision';
    }
  }
  if (!steps) steps = buildSteps(requirement);
  const planFile = join(dir, 'plan.md');
  writeFileSync(planFile, [
    '# 实施计划' + (derivation === 'delta+architect-decision' ? '（由 design 真产物推导）' : '（本地确定性模板）'),
    '',
    '| # | 步骤 | 落点 |',
    '|---|---|---|',
    ...steps.map((s, i) => '| ' + (i + 1) + ' | ' + s.what + ' | ' + s.where + ' |'),
    '',
    derivation === 'delta+architect-decision'
      ? '> 步骤来自多席位评审的 delta 与架构师裁决（evidenceLevel=real）。'
      : '> 步骤为模板推导，未经评审；执行前需人工确认（evidenceLevel=local-placeholder）。',
  ].join('\n') + '\n', 'utf8');
  // T-168：DELTA → 落点文件的机器可读映射（执行器按 id 取用；取不到就记 BLOCKED，不猜路径）
  let deltaFiles = {};
  let unmappedDeltas = [];
  if (deltaText) {
    const { buildDeltaFileMap } = await import('./pipeline-real.mjs');
    const built = buildDeltaFileMap({
      deltaText, decisionText,
      fallbackFile: extractTargetFiles(requirement)[0] || '',
    });
    deltaFiles = built.map;
    unmappedDeltas = built.unmapped;
  }
  const deltaMapFile = join(dir, 'delta-files.json');
  writeFileSync(deltaMapFile, JSON.stringify(deltaFiles, null, 2) + '\n', 'utf8');
  const workOrder = {
    generatedAt: nowIso(),
    project,
    sourceStage: 'design',
    sourceArtifact: design ? 'stage-01-design/stage.json' : null,
    derivation,
    steps,
    executor: 'titan-execute',
    // T-168：把评审 dispatchId 传给执行器（titan-execute 读 reviews/<dispatchId>/layer-b/delta.md + architect-decision.md）
    dispatchId: design && design.outputs ? (design.outputs.dispatchId || null) : null,
    // T-168：目标文件（titan-execute 用 --files 收窄到本次范围；不给就是全量）
    targetFiles: extractTargetFiles(requirement),
    // T-168：DELTA→落点映射（delta-files.json）；unmapped 的 DELTA 执行器会记 BLOCKED（不猜路径）
    deltaFiles: deltaFiles,
    deltaMapFile: 'delta-files.json',
    unmappedDeltas,
    note: '本执行单不直接改文件；改码走 titan-execute <dispatchId>（verify 前置）',
  };
  const woFile = join(dir, 'work-order.json');
  writeFileSync(woFile, JSON.stringify(workOrder, null, 2) + '\n', 'utf8');
  const realDesign = design && design.evidenceLevel === 'real';
  // 推导不出任何业务步骤（架构师全 REJECT/DEFER）→ 不许标 real
  const businessSteps = steps.filter((s) => !s.discipline && s.deltaId).length;
  const planReal = realDesign && derivation === 'delta+architect-decision' && businessSteps > 0;
  const res = writeStageArtifact(pipeline, 'plan', {
    startedAt,
    parentStageId: design ? design.timestamp : null,
    inputs: { project, designArtifact: design ? 'stage-01-design/stage.json' : null, requirement },
    outputs: { plan: 'plan.md', workOrder: 'work-order.json', stepCount: steps.length, derivation },
    decisions: [],
    artifacts: [planFile, woFile],
    evidenceLevel: planReal ? 'real' : (design ? 'local-placeholder' : 'pending'),
    notes: planReal
      ? ('由 stage-01 真 delta + architect 裁决推导（' + businessSteps + ' 个业务步骤）')
      : (derivation === 'delta+architect-decision'
        ? '真产物已推导但业务步骤为 0（架构师全 REJECT/DEFER）→ local-placeholder'
        : (design ? 'stage-01 非真产物 → 模板推导' : '缺 stage-01 产物（未跑 design）→ pending')),
  });
  return { ok: true, stage: 'plan', artifact: res.artifact, dir };
}

function buildSteps(requirement) {
  const base = [
    { what: '定位改动落点并确认无并发占用（M1 认领）', where: 'ISSUE_REGISTRY.json' },
    { what: '实现改动（一条一 commit）', where: '按落点' },
    { what: '补回归测试（orchestrator/test/ + SUITES.md 登记）', where: 'orchestrator/test/' },
    { what: '过闸：node orchestrator/verify-gate.mjs 全绿', where: 'verify-gate' },
    { what: 'M2 交叉验证（非作者客户端）+ 证据入库', where: 'archive/evidence/' },
    { what: '台账收口（status=done + verifier/evidence）', where: 'ISSUE_REGISTRY.json' },
  ];
  if (requirement) base.unshift({ what: '澄清需求边界与验收标准：' + requirement.slice(0, 60), where: '台账 description' });
  return base;
}

// ---------- implement ----------
async function runImplement(pipeline, { project, real }) {
  const startedAt = Date.now();

  const plan = readStageArtifact(pipeline, 'plan');
  const dir = stageDir(pipeline, 'implement');
  const cmdFile = join(dir, 'executor-command.txt');
  const planRef = plan ? 'stage-02-plan/work-order.json' : null;
  let wo = null;
  if (planRef && existsSync(join(stageDir(pipeline, 'plan'), 'work-order.json'))) {
    try { wo = JSON.parse(readFileSync(join(stageDir(pipeline, 'plan'), 'work-order.json'), 'utf8')); } catch { wo = null; }
  }
  writeFileSync(cmdFile, [
    '# 执行单（本阶段不改业务文件）',
    '',
    '# 1) 先做 scan：定位问题文件',
    'node orchestrator/orchestrate.mjs --scan <file> --repo <abs>',
    '',
    '# 2) 再走执行链（verify 前置通过才 commit）',
    wo && wo.dispatchId
      ? ('node orchestrator/titan-execute.mjs ' + wo.dispatchId + ' --executor opencode' +
         (wo.deltaMapFile ? ' --delta-map ' + (wo.sourceArtifact || '').replace(/stage-01-design\/stage\.json$/, 'stage-02-plan/') + wo.deltaMapFile : ''))
      : 'node orchestrator/titan-execute.mjs <dispatchId> --executor opencode',
    '',
    '# 3) 收口',
    'node orchestrator/edit-issue.mjs --id <T-xxx> --status done ...',
    '',
    '来源计划: ' + (planRef || '(缺 stage-02 产物 → 先跑 --plan)'),
    '项目: ' + (project || '-'),
  ].join('\n') + '\n', 'utf8');

  // T-168：真跑执行链（edit→verify→PASS→commit），落 execute-result.json
  let exec = null;
  if (real && wo && wo.dispatchId) {
    try {
      const { runExecutorChain } = await import('./pipeline-real.mjs');
      const files = Array.isArray(wo.targetFiles) ? wo.targetFiles : [];
      // delta 原文（用于判断落点是否在本次范围内）
      let execDeltaText = '';
      try {
        const dFile = join(stageDir(pipeline, 'design'), 'delta.md');
        if (existsSync(dFile)) execDeltaText = readFileSync(dFile, 'utf8');
      } catch { execDeltaText = ''; }
      // 只有当 delta 里的落点都在本次目标文件内才收窄；否则不传 --files
      // （传错会把所有 DELTA 过滤掉 → 执行器无事可做 → exit=2）
      const deltaFiles = [...new Set([...String(execDeltaText || '').matchAll(/([A-Za-z0-9_./-]+\.(?:mjs|js|cjs|ts|py|json|md|yaml|yml|ps1|html|css))/g)].map((m) => m[1]))];
      const inScope = files.length && deltaFiles.length && deltaFiles.every((f) => files.some((tf) => f.includes(tf) || tf.includes(f)));
      const execArgs = inScope ? ['--files', files.join(',')] : [];
      // T-168：把 plan 阶段产出的 DELTA→落点机器可读映射交给执行器（--delta-map）。
      // 不传 → 执行器只能从 delta.md 散文里猜文件（实测会拿到中文散文当路径）。
      const mapFile = join(stageDir(pipeline, 'plan'), 'delta-files.json');
      if (existsSync(mapFile)) execArgs.push('--delta-map', mapFile);
      exec = runExecutorChain({ dispatchId: wo.dispatchId, repoRoot: REPO_ROOT, executor: 'opencode', extraArgs: execArgs });
      const resFile = join(dir, 'execute-result.json');
      writeFileSync(resFile, JSON.stringify({
        dispatchId: wo.dispatchId, executor: 'opencode',
        exitCode: exec.exitCode, pass: exec.pass, ok: exec.ok,
        stdoutTail: exec.stdout, stderrTail: exec.stderr, at: nowIso(),
      }, null, 2) + '\n', 'utf8');
    } catch (e) {
      exec = { ok: false, exitCode: -1, pass: false, stdout: '', stderr: String((e && e.message) || e).slice(0, 300) };
      writeFileSync(join(dir, 'execute-result.json'), JSON.stringify({ dispatchId: wo.dispatchId, ok: false, error: exec.stderr, at: nowIso() }, null, 2) + '\n', 'utf8');
    }
  }

  const artifacts = [cmdFile];
  if (exec) artifacts.push(join(dir, 'execute-result.json'));
  const res = writeStageArtifact(pipeline, 'implement', {
    startedAt,
    parentStageId: plan ? plan.timestamp : null,
    inputs: { project, planArtifact: planRef, dispatchId: wo ? wo.dispatchId : null },
    outputs: { executorCommand: 'executor-command.txt', ...(exec ? { executeResult: 'execute-result.json' } : {}) },
    decisions: [],
    artifacts,
    evidenceLevel: exec && exec.ok && exec.pass ? 'real' : 'pending',
    notes: exec
      ? ('已跑 titan-execute（dispatchId=' + wo.dispatchId + '，exit=' + exec.exitCode + '，pass=' + exec.pass + '）')
      : (!real
        ? '未启用真链（加 --real 才跑 titan-execute）'
        : (plan
          ? (wo && wo.dispatchId ? '已产出执行单；titan-execute 未成功' : '已产出执行单；无 dispatchId（design 非真产物）')
          : '缺 stage-02 产物 → pending')),
  });
  return { ok: true, stage: 'implement', artifact: res.artifact, dir, exec };
}

// ---------- deliver ----------
async function runDeliver(pipeline, { project }) {
  const startedAt = Date.now();
  const dir = stageDir(pipeline, 'deliver');
  const stages = listPipelineStages(pipeline);
  const index = stages.map(s => ({
    stage: s.stage,
    evidenceLevel: s.evidenceLevel,
    artifact: 'stage-0' + (STAGE_ORDER.indexOf(s.stage) + 1) + '-' + s.stage + '/stage.json',
    outputs: s.outputs,
    artifacts: s.artifacts,
  }));
  // T-168：提交指针（implement 真跑过执行链 → 拿执行链的提交；否则取本仓最近提交并标注非本次产物）
  let commit = null;
  try {
    const g = spawnSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%H%x09%s'], { encoding: 'utf8' });
    if (g.status === 0) {
      const [hash, subject] = String(g.stdout).trim().split('\t');
      commit = { hash, subject, source: 'repo-latest' };
    }
  } catch { commit = null; }
  const idxFile = join(dir, 'artifact-index.json');
  writeFileSync(idxFile, JSON.stringify({ pipelineId: pipeline.id, project, stages: index, commit, generatedAt: nowIso() }, null, 2) + '\n', 'utf8');
  const allReal = stages.length === STAGE_ORDER.length && stages.every(s => s.evidenceLevel === 'real');
  const deliveryFile = join(dir, 'delivery.md');
  writeFileSync(deliveryFile, [
    '# 交付摘要',
    '',
    '- pipeline: ' + pipeline.id,
    '- 项目: ' + (project || '-'),
    '- 阶段数: ' + stages.length + '/' + STAGE_ORDER.length,
    '- 证据等级: ' + (stages.map(s => s.stage + '=' + s.evidenceLevel).join('、') || '(无)'),
    '- 提交指针: ' + (commit ? (commit.hash.slice(0, 12) + ' ' + commit.subject) : '(无)'),
    '- 提交指针来源: ' + (commit ? (commit.source === 'repo-latest' ? '本仓最近提交（**非本次 pipeline 产物**，仅供追溯）' : commit.source) : '(无)'),
    '',
    '## 阶段产物',
    ...stages.map(s => '- ' + s.stage + '（' + s.evidenceLevel + '）：' + (s.outputs && Object.values(s.outputs).join('、') || '-')),
    '',
    allReal
      ? '> 四阶段均为真产物（real）：多席位评审 → 架构师裁决 → 真计划 → 执行链落地。'
      : '> **未全部 real**：本摘要只代表框架产出索引；evidenceLevel 非 real 的阶段尚未由真实链路产出。',
  ].join('\n') + '\n', 'utf8');
  const res = writeStageArtifact(pipeline, 'deliver', {
    parentStageId: stages.length ? stages[stages.length - 1].timestamp : null,
    startedAt,
    inputs: { project, stageCount: stages.length },
    outputs: { delivery: 'delivery.md', index: 'artifact-index.json', ...(commit ? { commit: commit.hash } : {}) },
    decisions: [],
    artifacts: [deliveryFile, idxFile],
    evidenceLevel: allReal ? 'real' : (stages.length === STAGE_ORDER.length ? 'local-placeholder' : 'pending'),
    notes: allReal ? '四阶段真产物汇总' : '索引式交付摘要；非 real 阶段未由真实链路产出',
  });
  return { ok: true, stage: 'deliver', artifact: res.artifact, dir };
}

const STAGE_FN = { design: runDesign, plan: runPlan, implement: runImplement, deliver: runDeliver };

// ---------- 入口 ----------
export async function runPipelineMode({ mode, args, getFlagValue, repoRoot, project = null, stage = null }) {
  const requirement = (getFlagValue('--' + mode) || '').trim();
  const pipelineId = getFlagValue('--pipeline-id');
  let pipeline;
  if (mode === 'design' || mode === 'pipeline') {
    if (!requirement) {
      console.error('ERROR: --' + mode + ' 需要需求描述');
      return 2;
    }
    pipeline = createPipeline({ pipelineId: pipelineId || undefined, reviewsRoot: join(repoRoot, 'reviews') });
  } else {
    const found = pipelineId
      ? { id: pipelineId, dir: join(repoRoot, 'reviews', pipelineId), reviewsRoot: join(repoRoot, 'reviews') }
      : latestPipeline({ reviewsRoot: join(repoRoot, 'reviews') });
    if (!found) {
      console.error('[PIPELINE] 找不到可续跑的 pipeline（先跑 --design <需求>，或用 --pipeline-id 指定）');
      return 1;
    }
    pipeline = found;
    if (!existsSync(pipeline.dir)) {
      console.error('[PIPELINE] pipeline 不存在: ' + pipeline.id);
      return 1;
    }
  }

  const stagesToRun = mode === 'pipeline' ? STAGE_ORDER : [mode];
  // T-168：--real 开关（默认关 → 既有 12 个 active 模式行为不变；开 → 四阶段走真链路）
  // 布尔标志：getFlagValue 只认"带值"的旗标，裸 --real 要用 args.includes 判定
  const real = args.includes('--real') || !!getFlagValue('--real') || process.env.TITAN_PIPELINE_REAL === '1';
  // 席通道：all（默认）| api（批量快通道，不占浏览器）| web（附件终审）| local
  const seatArg = getFlagValue('--seats');
  const seatChannels = (seatArg && ['all', 'api', 'web', 'local'].includes(seatArg)) ? seatArg : 'all';
  const done = [];
  for (const st of stagesToRun) {
    const fn = STAGE_FN[st];
    let r;
    try {
      r = await fn(pipeline, { requirement, project, stage, real, seatChannels });
    } catch (e) {
      const reason = 'stage ' + st + ' 执行异常: ' + (e && e.message ? e.message : String(e));
      console.error('[PIPELINE] ' + reason);
      writePipelineEvidence(pipeline, { ok: false, failedStage: st, reason, stages: done });
      return 1;
    }
    done.push({ stage: st, evidenceLevel: r.artifact.evidenceLevel, artifact: r.artifact.timestamp });
    console.log('[PIPELINE] stage ' + st + ' 完成（evidenceLevel=' + r.artifact.evidenceLevel + '）→ ' + r.dir);
  }

  if (mode === 'pipeline') {
    const evidenceFile = writePipelineEvidence(pipeline, { ok: true, failedStage: null, reason: '', stages: done });
    console.log('[PIPELINE] 四阶段串链完成 → ' + pipeline.dir);
    console.log('[PIPELINE] 证据: ' + evidenceFile);
  }
  console.log('[PIPELINE] pipelineId=' + pipeline.id);
  return 0;
}

export default { runPipelineMode };
