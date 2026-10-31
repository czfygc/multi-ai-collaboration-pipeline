// titan-execute.mjs —— v2 薄执行器（读 delta+decision，执行 ACCEPT，verify 前置，同文件串行）
// 用法: node titan-execute.mjs <dispatchId> [--executor opencode|cline|kilo|harness]
// 约束: <200 行、不碰 orchestrate.mjs、verify 前置、同文件串行、edit→verify→PASS 才 commit

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { extractAlreadyResolvedProof, proofLineMatches } from './lib/already-resolved-proof.mjs';
import { checkFileSanity } from './lib/file-sanity.mjs';
import { runPairedTest, runSemanticGuard } from './lib/semantic-guard.mjs';
import { runProcess } from './lib/proc-tree.mjs';
import { runCapability, detectLanguage, VERIFY_STATUS } from './lib/verify-profiles.mjs';
// T-168（2026-10-22 修订）：**零探针**。原"派活前 HTTP 探针"已删除——它每轮探 4 个候选模型，
// 把免费池额度探挂了（用户裁定 + 4 席复核一致），且有界（4×15s）并非挂死元凶，只是净损耗。
// 现在：健康状态只读 model-health.mjs 本地健康表（T-172），失败再写回；落点走机器可读映射。
// 守卫逻辑（检查点/墙钟/二进制/结果写盘）抽到 lib/exec-run-guard.mjs（体量纪律拆回 50 KiB 线下）。
import { isProviderDownOutput, providerDownReason } from './lib/exec-model-guard.mjs';
import { createTrace, createWallBudget, checkExecutorReady, noteModelFailure, blockRemainingOnProviderDown, writeExecuteResult, buildNoOpResultRows } from './lib/exec-run-guard.mjs';
import { parseAcceptDeltas, applyFileAllowlist, detectBrokenDeltaInput } from './lib/exec-delta-parse.mjs';
// T-168: git scope → lib（体量线+git 超时），薄壳保原签名
import { captureDirtySet as _captureDirtySet, listUntracked as _listUntracked, cleanupOrphans as _cleanupOrphans, rollbackExecutorChanges as _rollbackExecutorChanges } from './lib/exec-git-scope.mjs';
const captureDirtySet = () => _captureDirtySet(TITAN_ROOT);
const listUntracked = () => _listUntracked(TITAN_ROOT);
const cleanupOrphans = (untrackedBefore, tag) => _cleanupOrphans({ root: TITAN_ROOT, untrackedBefore, tag });
const rollbackExecutorChanges = (base, tag) => _rollbackExecutorChanges({ root: TITAN_ROOT, base, preDirty, tag });

const __dirname = dirname(fileURLToPath(import.meta.url));
// P-27 修复（R3-002，kilo 席发现）：执行器修复轮曾在 ESM 里写 require('./config')/
// require('dotenv')——require 在 ESM 未定义，被 try/catch 静默吞掉，config/.env 加载
// 成死代码。改为 fs 直读（config.json → .env 逐行 → 默认，与 orchestrate 四级回退对齐）。
const TITAN_ROOT = (() => {
  if (process.env.D_TITAN_ROOT) return process.env.D_TITAN_ROOT;
  try {
    const cfgPath = join(__dirname, 'config.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg.TITAN_ROOT) return cfg.TITAN_ROOT;
    }
  } catch (_) {}
  try {
    const envPath = join(__dirname, '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const m = line.trim().match(/^D_TITAN_ROOT\s*=\s*(.+)$/);
        if (m) return m[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch (_) {}
  return resolve(__dirname, '..');
})();

const argv = process.argv.slice(2);
const dispatchId = argv[0];
// T-168：执行链持久化检查点（定位"挂死在哪一步"的唯一无额度手段）。
// 必须在任何 writeResult() 之前建好（writeResult 也要打 RESULT_WRITE 检查点）。
const execStartedAt = Date.now();
const traceHandle = createTrace({ dispatchId, root: TITAN_ROOT, startedAt: execStartedAt });
const trace = (event, fields = {}) => traceHandle.event(event, fields);
const executorName = argv.includes('--executor') ? argv[argv.indexOf('--executor') + 1] : 'opencode';
const skipBaseline = argv.includes('--skip-baseline');
// T-123：语义护栏开关（--skip-semantic 或 TITAN_SEMANTIC_GUARD=0 旁路，紧急用）
const skipSemantic = argv.includes('--skip-semantic') || process.env.TITAN_SEMANTIC_GUARD === '0';
// T-123：配对回归测试目录（orchestrator/test/<base>.test.mjs 同名自动发现）
const SEMANTIC_TEST_DIR = join(TITAN_ROOT, 'orchestrator', 'test');
// --file <path>：强制所有 ACCEPT DELTA 指向该文件（scan 单文件模式专用——
// 模型回报的 delta.file 实测有 unknown/code.js 幻觉，会导致假 PASS 与根目录污染）
const forceFile = argv.includes('--file')
  ? (argv[argv.indexOf('--file') + 1] || '').replace(/\\/g, '/')
  : '';
// T-49 R2 --files <a,b,c>：多文件白名单模式（不强制覆盖，但 delta.file 必须落在
// 清单内——含 basename 唯一匹配归一；越界/幻觉路径直接 FAIL，不派执行器）
const allowFiles = argv.includes('--files')
  ? (argv[argv.indexOf('--files') + 1] || '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean)
  : null;
// R3 预留接口层（T-61 C-11 注册，计划 §4 R3）：任务类型槽——默认 'fix'（现有实装路径不变）；
// implement|scaffold 为 V8/P12 实施链预留，命中即报"未实现"退 0（与 R1 stub 同口径，便于探活）。
// language 槽（js|py）：T-163 起**实装**——透传给 verify 选择（消费 R4 verify-profiles 槽，
// orchestrator/config/verify-profiles.json）：按语言对改动文件做 syntax 检查。
const taskTypeArg = argv.includes('--task-type') ? argv[argv.indexOf('--task-type') + 1] : null;
const taskType = (taskTypeArg && !taskTypeArg.startsWith('--')) ? taskTypeArg : 'fix';
const languageArg = argv.includes('--language') ? argv[argv.indexOf('--language') + 1] : null;
const language = (languageArg && !languageArg.startsWith('--')) ? languageArg.toLowerCase() : 'js';
if (!['js', 'py'].includes(language)) {
  console.error('ERROR: --language 必须是 js 或 py（收到: ' + language + '）');
  process.exit(2);
}
// T-168 --delta-map：DELTA 落点机器可读映射（{ "DELTA-001": "path" }，plan 阶段产出；旧路径会把中文散文当路径）
const deltaMapPath = argv.includes('--delta-map') ? argv[argv.indexOf('--delta-map') + 1] : '';
let deltaMap = null;
if (deltaMapPath && !deltaMapPath.startsWith('--')) {
  try {
    const m = JSON.parse(readFileSync(deltaMapPath, 'utf8'));
    if (m && typeof m === 'object') deltaMap = m;
  } catch { /* 映射读不到 → 退回 delta.md 解析（并如实记账） */ }
}

if (argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node titan-execute.mjs <dispatchId> [选项]',
    '',
    '薄执行器：读 reviews/<dispatchId>/layer-b/delta.md 与 architect-decision.md，',
    '对 ACCEPT 的 DELTA 派执行器修复，verify 前置通过才 commit（edit→verify→PASS）。',
    '',
    '选项:',
    '  --executor <name>   执行器 opencode|cline|kilo|harness（默认 opencode）',
    '  --file <path>       强制所有 ACCEPT DELTA 指向该文件（scan 单文件模式防幻觉路径）',
    '  --files <a,b,c>     多文件白名单模式（delta.file 必须落在清单内）',
    '  --skip-baseline     跳过范围基线检查（慎用）',
    '  --task-type <fix|implement|scaffold>  R3 任务类型槽：implement/scaffold 未实现退 0（默认 fix）',
    '  --language <js|py>      R3 语言槽（T-163 实装）：透传给 verify profile 做 syntax 检查（默认 js）',
    '  --help, -h          显示本帮助'
  ].join('\n'));
  process.exit(0);
}

// R3 预留：implement|scaffold 任务类型未实现（P11/P12 实装前堵在入口，探活友好退出 0）
if (taskType === 'implement' || taskType === 'scaffold') {
  console.log('[R3] taskType=' + taskType + ' 已注册但未实现（R3 预留槽，见计划 §8 P11/P12；当前实装仅 fix）。');
  process.exit(0);
}

if (!dispatchId) {
  console.error('用法: node titan-execute.mjs <dispatchId> [--executor opencode|cline|kilo|harness] [--file <path>] [--skip-baseline] [--help]');
  process.exit(2);
}

// 读配置
const profilesPath = join(TITAN_ROOT, 'config', 'executor-profiles.json');
if (!existsSync(profilesPath)) {
  console.error('[MISSING] config/executor-profiles.json 不存在');
  process.exit(2);
}
const profiles = JSON.parse(readFileSync(profilesPath, 'utf8'));
const profile = profiles[executorName];
if (!profile) {
  console.error('[BAD_EXECUTOR] 未知执行器: ' + executorName + '，可选: ' + Object.keys(profiles).join(', '));
  process.exit(2);
}

// Kilo VS Code 扩展会静默自动更新（实测 7.8.3→7.8.8，2026-10-08），版本化目录名使硬编码路径失效：
// cmd[0] 指向 kilocode.kilo-code-*\bin\kilo.exe 且不存在时，扫描扩展目录按语义版本取最新可用档。
if (profile.cmd && profile.cmd[0] && /kilocode\.kilo-code-/.test(profile.cmd[0]) && !existsSync(profile.cmd[0])) {
  const m = profile.cmd[0].match(/^(.*)kilocode\.kilo-code-[^\\/]+[\\/]bin[\\/]kilo\.exe$/);
  if (m) {
    try {
      let best = null, bestV = [-1, -1, -1];
      for (const d of readdirSync(m[1])) {
        const vm = d.match(/^kilocode\.kilo-code-(\d+)\.(\d+)\.(\d+)/);
        if (!vm) continue;
        const exe = join(m[1], d, 'bin', 'kilo.exe');
        if (!existsSync(exe)) continue;
        const v = [+vm[1], +vm[2], +vm[3]];
        if (v[0] > bestV[0] || (v[0] === bestV[0] && v[1] > bestV[1]) || (v[0] === bestV[0] && v[1] === bestV[1] && v[2] > bestV[2])) {
          bestV = v; best = exe;
        }
      }
      if (best) {
        console.log('[RESOLVE] kilo 路径失效，按最新版本重定向: ' + best);
        profile.cmd[0] = best;
      }
    } catch { /* 目录不可读则保持原路径，由 spawn 报错 */ }
  }
}

// 读 delta.md + architect-decision.md
const layerB = join(TITAN_ROOT, 'reviews', dispatchId, 'layer-b');
const deltaPath = join(layerB, 'delta.md');
const decisionPath = join(layerB, 'architect-decision.md');
if (!existsSync(deltaPath) || !existsSync(decisionPath)) {
  console.error('[MISSING] delta.md 或 architect-decision.md 不存在，请先跑 --analyze/--architect');
  process.exit(2);
}

const deltaMd = readFileSync(deltaPath, 'utf8');
const decisionMd = readFileSync(decisionPath, 'utf8');

// 解析 ACCEPT 的 DELTA（兼容实时格式：### DELTA-001 + Decision: ACCEPT）
// T-168：解析与白名单归一已抽到 lib/exec-delta-parse.mjs（纯函数，便于单测；体量纪律拆出）。
const parsedDeltas = parseAcceptDeltas({
  deltaText: deltaMd, decisionText: decisionMd, deltaMap, forceFile,
});
// 无落点的 DELTA **不静默丢**（ChatGPT 复核 P1）：单列出来，稍后如实记 BLOCKED。
const unresolvedDeltas = parsedDeltas.filter((d) => !d.file && !forceFile);
const acceptDeltas = parsedDeltas.filter((d) => d.file || forceFile);
if (unresolvedDeltas.length) {
  console.log('[SCOPE] ⚠ ' + unresolvedDeltas.length + ' 个 ACCEPT DELTA 没有可用落点（不猜路径）→ 记 BLOCKED: ' +
    unresolvedDeltas.map((d) => d.id).join(','));
}
if (forceFile) {
  for (const d of acceptDeltas) d.file = forceFile;
  console.log('[SCOPE] --file 强制单文件模式: ' + forceFile + '（' + acceptDeltas.length + ' 个 DELTA）');
} else if (allowFiles) {
  // R2 白名单归一：精确命中 → 原样；basename 唯一命中 → 归一；否则剔除（幻觉/越界路径）
  const norm = applyFileAllowlist({ deltas: acceptDeltas, allowFiles });
  console.log('[SCOPE] --files 白名单模式: ' + allowFiles.length + ' 个文件，' + norm.kept.length + '/' + acceptDeltas.length + ' 个 DELTA 通过归一' + (norm.dropped ? '，剔除 ' + norm.dropped + ' 个幻觉/越界路径' : ''));
  // 重排 accepted 列表为白名单通过项（分组由下方 groups 循环统一完成）
  acceptDeltas.length = 0;
  acceptDeltas.push(...norm.kept);
  if (acceptDeltas.length === 0) {
    writeResult(dispatchId, executorName, [], 'FAIL', '', 2);
    console.error('[SCOPE] 白名单内无可执行 DELTA');
    process.exit(2);
  }
}
// T-168 输入体检（占位/空/无裁决 → BLOCKED；口径见 lib/exec-delta-parse.detectBrokenDeltaInput）
const brokenInput = detectBrokenDeltaInput({ deltaText: deltaMd, decisionText: decisionMd });
const inputBroken = brokenInput.reason;
if (inputBroken) trace('DELTA_INPUT_BROKEN', brokenInput);

if (acceptDeltas.length === 0) {
  // T-168：无可执行 DELTA 的三分法（未落点/输入没生成完 → BLOCKED；真·全 REJECT → PASS）
  const noOp = buildNoOpResultRows({ unresolved: unresolvedDeltas, brokenReason: inputBroken });
  if (noOp.status === 'BLOCKED') console.error('❌ ' + noOp.reason + ' → 记 BLOCKED，不报成功');
  else console.log('✅ 无 ACCEPT DELTA，无需执行');
  writeResult(dispatchId, executorName, noOp.rows, noOp.status, '', noOp.exitCode);
  if (noOp.status === 'BLOCKED') trace('RESULT_WRITE', { status: noOp.status, exitCode: noOp.exitCode, reason: noOp.reason });
  process.exit(noOp.exitCode);
}

const groups = new Map();
for (const d of acceptDeltas) {
  const arr = groups.get(d.file) || [];
  arr.push(d);
  groups.set(d.file, arr);
}

// T-168（ChatGPT P1）：git 统一 30s 超时（TITAN_EXEC_GIT_TIMEOUT_MS 可覆盖）——git 卡住会同步阻塞主循环、击穿墙钟。
const GIT_TIMEOUT_MS = Number(process.env.TITAN_EXEC_GIT_TIMEOUT_MS) > 0 ? Number(process.env.TITAN_EXEC_GIT_TIMEOUT_MS) : 30000;
function gitSync(args, opts = {}) {
  return spawnSync('git', args, { cwd: TITAN_ROOT, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, ...opts });
}

// 执行器配置
const cmd = profile.cmd;
const modelFlag = profile.modelFlag;
const defaultModel = profile.defaultModel;
const extraArgs = profile.extraArgs || [];
const env = { ...process.env, ...Object.fromEntries(Object.entries(profile.env).map(([k, v]) => [k, v.replace('${FREELLMAPI_API_KEY}', process.env.FREELLMAPI_API_KEY || '').replace('${TITAN_ROOT}', TITAN_ROOT)])) };
const cwd = profile.cwd.replace('${TITAN_ROOT}', TITAN_ROOT);
const timeoutMs = profile.timeoutMs;

// P-11：超时退避链（600s→等30s→重试→降档 executor→BLOCKED 记账）。
// env TITAN_EXEC_TIMEOUT_MS / TITAN_EXEC_BACKOFF_MS 供测试用小超时模拟（不破坏生产默认）。
const TIMEOUT_OVERRIDE_MS = Number(process.env.TITAN_EXEC_TIMEOUT_MS) > 0 ? Number(process.env.TITAN_EXEC_TIMEOUT_MS) : 0;
const BACKOFF_MS = Number(process.env.TITAN_EXEC_BACKOFF_MS) > 0 ? Number(process.env.TITAN_EXEC_BACKOFF_MS) : 30000;
const DEGRADE_ORDER = ['opencode', 'cline', 'kilo', 'harness'];
// T-124：空闲看门狗——进程活着但 stdout/stderr 静默 idleMs 毫秒即判挂起并杀整棵树
// （真挂起不再干等满 600s；慢但有输出的正常工作不受影响——opencode --format json 会持续吐事件）。
// 0 = 关闭。
const IDLE_MS = Number(process.env.TITAN_EXEC_IDLE_MS) >= 0 ? Number(process.env.TITAN_EXEC_IDLE_MS) : 300000;
// T-124：每 delta 累计预算——降档链最坏约 1 小时，远超调用方外层预算（scan-entry 900s），
// 必被中途砍断并留下半成品改动+孤儿。预算耗尽即止链、记 BLOCKED、回滚、如实上报。
// 默认 600s < 外层 900s：让执行器自己在预算内收尾，而不是被外层砍。
const DELTA_BUDGET_MS = Number(process.env.TITAN_EXEC_DELTA_BUDGET_MS) > 0 ? Number(process.env.TITAN_EXEC_DELTA_BUDGET_MS) : 600000;

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 以指定档案名执行一次（原 runExecutor 泛化：cline 走 PowerShell 包装，其余走通用 cmd 数组）
// T-124：改异步 runProcess（空闲看门狗 + 硬超时 + 杀整棵树）——旧 spawnSync 超时只杀直接
// 子进程，LLM 孙进程变孤儿继续跑，可在本轮判失败后仍改动工作树甚至提交。
async function execAs(profileName, promptText, label) {
  const p = profiles[profileName];
  if (!p || !p.cmd || !p.cmd[0]) return { exitCode: null, stdout: '', stderr: '', unavailable: true, error: 'no profile: ' + profileName };
  const t = TIMEOUT_OVERRIDE_MS || p.timeoutMs || 600000;
  const pCwd = (p.cwd || '.').replace('${TITAN_ROOT}', TITAN_ROOT);
  const pEnv = { ...process.env, ...Object.fromEntries(Object.entries(p.env || {}).map(([k, v]) => [k, v.replace('${FREELLMAPI_API_KEY}', process.env.FREELLMAPI_API_KEY || '').replace('${TITAN_ROOT}', TITAN_ROOT)])) };
  const tmpDir = join(TITAN_ROOT, 'tmp');
  if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true });
  const promptFile = join(tmpDir, `titan-prompt-${label}-${profileName}-${Date.now()}.txt`);
  writeFileSync(promptFile, promptText, 'utf8');
  let cmd;
  let args;
  if (profileName === 'cline') {
    // Cline requires pre-seeded providers.json in --data-dir (OPENAI_BASE_URL env doesn't work)
    const dataDir = p.dataDir ? p.dataDir.replace('${TITAN_ROOT}', TITAN_ROOT) : join(TITAN_ROOT, 'tmp', 'cline-data');
    const provider = p.provider || 'openai-compatible';
    const providerBaseUrl = p.providerBaseUrl || 'http://127.0.0.1:3001/v1';
    const apiKey = (p.apiKeyEnv && process.env[p.apiKeyEnv]) || process.env.FREELLMAPI_API_KEY || 'local';
    pEnv.OPENAI_API_KEY = apiKey;
    if (!existsSync(dataDir)) mkdirSync(dataDir + '/settings', { recursive: true });
    const providersJson = join(dataDir, 'settings', 'providers.json');
    writeFileSync(providersJson, JSON.stringify({
      version: 1,
      lastUsedProvider: provider,
      modes: {},
      providers: {
        [provider]: {
          settings: {
            provider,
            apiKey,
            model: p.defaultModel,
            protocol: 'openai-chat',
            client: 'openai-compatible',
            contextWindow: 1048576,
            baseUrl: providerBaseUrl,
            capabilities: ['streaming', 'tools'],
          },
          updatedAt: new Date().toISOString(),
          tokenSource: 'manual',
        },
      },
    }, null, 2), 'utf8');
    const ps = `$p = Get-Content -Raw "${promptFile}"; & '${p.cmd[0]}' $p ${p.modelFlag} "${p.defaultModel}" ${(p.extraArgs || []).join(' ')} -c "${pCwd}" --data-dir "${dataDir}" 2>&1 | Out-String`;
    cmd = 'powershell';
    args = ['-NoProfile', '-Command', ps];
  } else {
    cmd = p.cmd[0];
    // T-168：执行器模型 = 档案里钉的模型（探针已删除，不再有"探针挑中的模型"）。
    // 降档执行器保留各自档案里的模型（它们多半不是 freellmapi 网关口径）。
    const model = p.defaultModel;
    args = [...p.cmd.slice(1), promptText, ...(p.modelFlag && model ? [p.modelFlag, model] : []), ...(p.extraArgs || [])];
  }
  trace('EXECUTOR_SPAWN', { executor: profileName, cmd, model: profileName === executorName ? p.defaultModel : null, cwd: pCwd, timeoutMs: t });
  let firstOutputAt = null;
  const r = await runProcess({
    cmd, args, cwd: pCwd, env: pEnv, timeoutMs: t, idleMs: IDLE_MS, label: label + '/' + profileName,
    onOutput: () => { if (firstOutputAt === null) { firstOutputAt = Date.now(); trace('EXECUTOR_FIRST_OUTPUT', { executor: profileName, label, afterMs: firstOutputAt - execStartedAt }); } },
  });
  trace('EXECUTOR_EXIT', {
    executor: profileName, label, exitCode: r.exitCode, timedOut: !!r.timedOut, hung: !!r.hung,
    durationMs: r.durationMs, error: r.error || null, firstOutputAt: firstOutputAt ? firstOutputAt - execStartedAt : null,
  });
  return {
    exitCode: r.exitCode,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    timedOut: !!r.timedOut,
    hung: !!r.hung,
    durationMs: r.durationMs,
    error: r.error || null
  };
}

// 超时退避链：primary 一次 + 重试一次 + 降档（opencode→cline→kilo→harness，缺失档案跳过）。
// 全部超时 → timedOutAll（BLOCKED 记账，exit 3），有非超时结果（含 exit!=0）即返回。
// T-124：链内受每 delta 预算约束（deadline 到点即止链）；挂起/超时的尝试一律先杀树再回滚
// （onKill 回调由主循环提供），确保下一档执行器从干净基线起步。
async function runWithTimeoutChain(promptText, label, opts = {}) {
  const chain = [executorName, executorName, ...DEGRADE_ORDER.filter((x) => x !== executorName)];
  const tried = [];
  const deadline = opts.deadline || 0;
  const onKill = typeof opts.onKill === 'function' ? opts.onKill : null;
  let hungCount = 0;
  let timeoutCount = 0;
  for (const name of chain) {
    if (deadline && Date.now() >= deadline) {
      console.log('[BUDGET] 本 delta 累计预算耗尽，止链（剩余执行器不再尝试）');
      return { exitCode: null, stdout: '', stderr: '', budgetExhausted: true, tried, hungCount, timeoutCount };
    }
    const r = await execAs(name, promptText, label);
    tried.push({ executor: name, exitCode: r.exitCode, timedOut: !!r.timedOut, hung: !!r.hung, unavailable: !!r.unavailable, durationMs: r.durationMs });
    if (r.unavailable) continue;
    if (r.timedOut || r.hung) {
      if (r.hung) hungCount++; else timeoutCount++;
      const why = r.hung
        ? '挂起（空闲 ' + IDLE_MS + 'ms 无输出）'
        : '超时（' + (TIMEOUT_OVERRIDE_MS || (profiles[name] && profiles[name].timeoutMs) || 600000) + 'ms）';
      console.log('[TIMEOUT] ' + name + ' ' + why + ' → 杀进程树 + 回滚本 delta 改动 → 退避 ' + BACKOFF_MS + 'ms 后继续');
      if (onKill) onKill(r.hung ? 'executor-hang' : 'executor-timeout');
      await sleepMs(BACKOFF_MS);
      continue;
    }
    return { ...r, tried, hungCount, timeoutCount };
  }
  return { exitCode: null, stdout: '', stderr: '', timedOutAll: true, tried, hungCount, timeoutCount };
}

// 结果收集
const results = [];
let allPass = true;
// T-168：已处理 DELTA 集合（模型不可用时据此把"剩下的"一并记 BLOCKED）
const doneDeltaIds = new Set();
// T-168（ChatGPT 复核 P1）：无落点的 ACCEPT DELTA 如实记 BLOCKED，不静默丢（漏了几条必须看得见）。
for (const d of unresolvedDeltas) {
  results.push({ deltaId: d.id, file: '(未解析落点)', status: 'BLOCKED', exitCode: null, reason: 'delta-target-unresolved', finding: d.finding, action: d.action });
  doneDeltaIds.add(d.id);
}
if (unresolvedDeltas.length) allPass = false;

// T-168：执行链**持久化检查点**——trace 已在 argv 解析后建好（见上），此处只补首批事件。
trace('EXEC_START', { dispatchId, executor: executorName, pid: process.pid, cwd: TITAN_ROOT });
trace('DELTA_MAP_LOADED', { hasMap: !!deltaMap, mapKeys: deltaMap ? Object.keys(deltaMap).length : 0, acceptDeltas: acceptDeltas.length });

// T-168：整轮 implement 的**全局墙钟预算**（原来只有"每条 DELTA 600s"，
// 9 条 × 600s = 90 分钟上限 → 体感就是"挂死"，而且 stage.json 永远不写）。
// 到点即止链 + 记 BLOCKED + 正常写结果（外层一定能拿到 stage.json）。
const budget = createWallBudget({ startedAt: execStartedAt });
const MAX_WALL_MS = budget.maxWallMs;
const globalDeadline = budget.deadline;

// T-168：执行器就绪检查（**零网络**）：只读健康表 + 可执行文件存在性。
//   口径：TTL 内标 down → spawn 之前 fail fast（不拿死模型烧额度）；TTL 外 → 不拦。
const ready = checkExecutorReady({ profiles, executorName, root: TITAN_ROOT, env: process.env });
trace('HEALTH_CONSULT', {
  model: ready.health ? ready.health.model : null,
  state: ready.health ? ready.health.state : null,
  blocked: ready.health ? ready.health.blocked : null,
  reason: ready.health ? ready.health.reason : null,
  candidates: ready.health ? ready.health.candidates.map((c) => ({ id: c.id, state: c.state })) : [],
});
console.log('[HEALTH] 模型健康(只读健康表): ' + (ready.health ? ready.health.model + ' state=' + ready.health.state : '(无档案)') +
  ' | 候选: ' + (ready.health ? ready.health.candidates.map((c) => c.id + '=' + c.state).join(', ') || '(无)' : ''));
if (ready.binary) {
  trace('EXECUTOR_RESOLVE', { configured: (profiles[executorName] || {}).cmd?.[0], resolved: ready.binary.cmd, source: ready.binary.source });
}
if (!ready.ok) {
  for (const d of acceptDeltas) {
    results.push({ deltaId: d.id, file: d.file || '(未解析)', status: 'BLOCKED', exitCode: null, reason: ready.reason + ': ' + ready.detail });
  }
  writeResult(dispatchId, executorName, results, 'BLOCKED', '', ready.exitCode || 3);
  trace('RESULT_WRITE', { status: 'BLOCKED', exitCode: ready.exitCode || 3, reason: ready.reason });
  console.error('❌ ' + ready.detail + ' → 本轮不执行，记 BLOCKED');
  process.exit(ready.exitCode || 3);
}
if (ready.binary && ready.binary.cmd !== (profiles[executorName] || {}).cmd?.[0]) {
  console.log('[EXEC-BIN] 执行器路径改用 ' + ready.binary.cmd + '（来源: ' + ready.binary.source + '）');
  profiles[executorName].cmd[0] = ready.binary.cmd;
}

// 记录运行前的基准提交
let baseCommit = gitSync(['rev-parse', 'HEAD']).stdout.trim();

// 运行前脏文件基线（含未跟踪）：调用方自己未提交的工作不算执行器越界。
// 历史事故：曾用全树 diff 把调用方未提交源码判为越界 → reset --hard 抹掉（M7 违规）。
// （T-168：已抽到 lib/exec-git-scope.mjs —— 体量纪律拆出 + git 调用统一带超时）
const preDirty = captureDirtySet(TITAN_ROOT);

// T-49 sanity 护栏（T-56 W7 提取至 lib/file-sanity.mjs 成正式 titan-sanity suite）：
// 执行器曾把 3665 行文件删成一行 "ALREADY_RESOLVED"，verify 只查 scope/范围照样 PASS——
// 毁灭性删改必须当场拦截（协议标记/体积减半/语法/导入冒烟，见 checkFileSanity）。
function checkSanity(file, pre, diffText) {
  return checkFileSanity(join(TITAN_ROOT, file), pre || null, { diffText });
}

// T-49 孤儿清理 + P-23 回滚 → lib/exec-git-scope.mjs

// P-23（T-49 R2 实测）：错挂文件的 delta 失败时，旧回滚只还原 delta.file——执行器实际
// 编辑的其他文件留在脏区（008 错挂 cdp-client、实改 A-orchestrate，半截 import 手术遗留）。
// 正确回滚 = 还原本 delta 基线以来的全部已跟踪改动；preDirty（运行前已脏=他人未提交工作，
// M7 绝不碰）与 reviews/tmp（证据/日志）豁免。
// （T-168：已抽到 lib/exec-git-scope.mjs —— 体量纪律拆出 + git 调用统一带超时）

// T-163：最近一次 verify 的 profile 结果（syntax 检查状态），随结果条目落盘供审计。
let lastVerifyProfile = null;

// 验证函数：target 必改（scoped diff）+ 范围检查（全树 diff，排除 preDirty）+ verify-baseline（可选）
async function verify(delta, fullDiff, scopedDiff, requireTargetChange = true) {
  // 0. 目标文件必须真的被改了（scoped diff 为空 = 执行器没动它 → 空验证假 PASS 风险；
  // 仅当执行器按协议显式回报 ALREADY_RESOLVED 时，调用方降级为不要求）
  if (requireTargetChange && !scopedDiff.trim()) {
    console.log('❌ 目标文件未被修改（' + delta.file + ' 的 diff 为空）');
    return false;
  }
  // 1. diff 范围检查：只改目标文件 + 允许的附属变更；运行前已脏的文件豁免
  const diffFiles = fullDiff.split('\n').filter(l => l.startsWith('diff --git')).map(l => l.split(' ')[2].slice(2).replace(/\\/g, '/'));
  const untrackedNow = (gitSync(['ls-files', '--others', '--exclude-standard']).stdout || '')
    .split('\n').filter(Boolean).map(f => f.replace(/\\/g, '/'));
  const changed = [...new Set([...diffFiles, ...untrackedNow])];
  const allowedExtra = ['node_modules/', '.vite/', 'dist/', 'build/', '.git/', 'tmp/',
    // P-24（T-49 R2-final 实测）：操作员文档区豁免——用户手动存网页席工作文件
    // （design-specs/*.txt）落盘在运行中，被未跟踪检查误判执行器越界，团灭 4 条
    // already-resolved A- 席 delta。执行器只该产出代码，docs/design-specs 类目录
    // 的运行中新文件一律不算执行器责任。
    'design-specs/', 'docs/', 'archive/'];
  const unexpected = changed.filter(f => {
    if (f === delta.file) return false;
    if (f.startsWith('reviews/')) return false;
    if (allowedExtra.some(p => f.startsWith(p))) return false;
    if (preDirty.has(f)) return false; // 运行前就已脏：调用方自己的未提交工作，不是执行器的锅
    // 允许同目录下的测试文件变更（同模块测试同步）
    if (f.startsWith('tests/') && delta.file.startsWith('src/')) return false;
    if (f.startsWith('src/') && delta.file.startsWith('tests/')) return false;
    return true;
  });
  if (unexpected.length) {
    console.log('❌ diff 范围违规，意外文件:', unexpected.join(', '));
    return false;
  }

  // 2. target_cmd（若 delta 有指定） —— 这里简化
  // 3. verify-baseline（可跳过）
  const skipBaseline = process.argv.includes('--skip-baseline');
    if (!skipBaseline) {
    const vb = spawnSync('node', ['orchestrator/verify-baseline.mjs', dispatchId], {
      cwd: TITAN_ROOT, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'pipe']
    });
    if (vb.status !== 0) {
      console.log('❌ verify-baseline FAIL');
      console.log(vb.stdout);
      return false;
    }
  }
  // 4. T-163（R3 language 槽实装 + R4 verify-profiles 消费）：按语言对改动文件做 syntax 检查。
  //    口径：FAIL → verify 失败（语法坏了就是坏了）；UNKNOWN → 显式记账但不阻断
  //    （profile 无此能力/语言未知——不等于通过，也不等于失败）。
  const fileLang = detectLanguage(delta.file) || language;
  const prof = runCapability({ language: fileLang, file: join(TITAN_ROOT, delta.file), capability: 'syntax', cwd: TITAN_ROOT });
  lastVerifyProfile = { status: prof.status, profile: prof.profile, language: fileLang, reason: prof.reason || '' };
  if (prof.status === VERIFY_STATUS.FAIL) {
    console.log('❌ verify-profile syntax FAIL (' + prof.profile + '): ' + (prof.output || '').slice(-500));
    return false;
  }
  if (prof.status === VERIFY_STATUS.UNKNOWN) {
    console.log('⚠ verify-profile UNKNOWN（显式未知，不阻断）: ' + prof.reason);
  } else {
    console.log('✅ verify-profile syntax PASS (' + prof.profile + ')');
  }
  return true;
}

// 主循环：按文件分组串行
outer: for (const [file, deltas] of groups) {
  console.log('\n=== 处理文件:', file, '(', deltas.length, '个 DELTA ) ===');
  for (const delta of deltas) {
    // T-168：整轮 implement 的**全局墙钟**闸（15 分钟默认）——到点即止链。
    // 原来只有"每条 DELTA 600s"，9 条 = 90 分钟上限 → 外层看到的永远是"挂死"，
    // 而且 stage.json 永远不落盘。现在到点即记 BLOCKED + 正常写结果。
    if (Date.now() >= globalDeadline) {
      console.log('⛔ implement 全局墙钟预算耗尽（' + MAX_WALL_MS + 'ms）→ 剩余 DELTA 记 BLOCKED');
      for (const rest of acceptDeltas) {
        if (doneDeltaIds.has(rest.id)) continue;
        results.push({ deltaId: rest.id, file: rest.file, status: 'BLOCKED', exitCode: null, reason: 'implement-wall-budget-exhausted' });
        doneDeltaIds.add(rest.id);
      }
      trace('WALL_BUDGET_EXHAUSTED', { maxWallMs: MAX_WALL_MS, remaining: acceptDeltas.length - doneDeltaIds.size });
      break outer;
    }
    console.log('\n---', delta.id, '---');
    trace('DELTA_START', { deltaId: delta.id, file: delta.file });
    console.log('文件:', delta.file);
    console.log('发现:', delta.finding);
    console.log('动作:', delta.action);
    doneDeltaIds.add(delta.id);

    // P-16（T-49 runs4-7 实测）：历史已有本 delta 的修复提交 → 跳过重跑。全量重跑会诱发
    // 执行器对已修项"再优化"（非确定性），部分改法炸语法被 sanity 拦下 → 每轮 verifyStatus
    // 振荡、永不收敛。git log 从 HEAD 走，命中=修复在当前历史内有效（revert 过的不命中）。
    // P-18 根治（R2 实测第二击）：delta ID 跨 dispatch 撞号——R1 的 [DELTA-xxx] 提交与 R2
    // 同号且同文件，路径过滤仍误判"已修"。修复提交必须带 dispatchId 前缀，skip 检查同缀匹配。
    // 强制重跑用 --no-skip-prior-fixed。
    if (!argv.includes('--no-skip-prior-fixed')) {
      const priorFix = gitSync(['log', '--oneline', '-1', '--grep=^\\[' + dispatchId + '\\]\\[' + delta.id + '\\]', '--', delta.file]);
      if (priorFix.stdout && priorFix.stdout.trim()) {
        results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0, reason: 'fixed-in-prior-run', finding: delta.finding, action: delta.action });
        console.log('⏭', delta.id, 'PASS (fixed-in-prior-run：历史已有修复提交，防再编辑抖动)');
        continue;
      }
    }

    // P-15 修复（T-49 run3 实战）：范围基线每 delta 刷新到当前 HEAD。旧实现把基线钉在
    // 开跑时的 commit（仅 PASS 后刷新），导致"运行期间的外部提交"（并行开发/其他客户端/
    // 编排者自己的设施提交）全部落进 git diff baseCommit 的范围检查——run3 实测 023-039
    // 共 16 条 already-resolved 被误判"范围违例"团灭。每 delta 刷新后，diff 窗口只剩
    // 本 delta 执行器的改动；preDirty 仍豁免运行前已脏文件。
    baseCommit = gitSync(['rev-parse', 'HEAD']).stdout.trim();

    // 构建 prompt（不让执行器提交，验证后由 titan-execute 统一 commit）
    const prompt = `改 ${delta.file}：${delta.finding}。建议：${delta.action}。
约束：只改这个文件；**不提交**，改完直接返回。
编辑方式硬约束（违反会被 sanity 护栏当场拦截并整单回滚）：
1) 禁止整文件重写——必须用编辑工具做最小定点替换；若需改动超过 50 行，停下并在输出中说明（拆小重派），不要强改。
2) 禁止用 PowerShell/echo/tee/重定向等 shell 命令写文件（含 Set-Content/Out-File）。
3) 禁止改变编码与行尾——保持 UTF-8 无 BOM、LF，禁止引入 CR（回车符）。
你只允许修改上面指定的这一个文件；改动任何其他文件都会被范围检查拒绝并回滚。
ALREADY_RESOLVED 判断（如适用）必须写在你 stdout 回复文本里，**绝对禁止把 ALREADY_RESOLVED 或任何协议标记写进文件**。
若该 finding 对本文件当前代码已不成立（例如同轮前序 DELTA 已修复同一问题），不要做无意义改动，
改为在输出中单独包含一行：ALREADY_RESOLVED
提交信息将由系统生成：[${delta.id}] fix: ${delta.finding.slice(0, 60)}`;

    // 执行器调用（runExecutor 内部落 promptFile 留档审计）
    // T-49：捕获执行前基线（行数，供 sanity 体积护栏）与本 delta 运行前未跟踪集（供孤儿清理）
    let preState = null;
    try { preState = { lines: readFileSync(join(TITAN_ROOT, delta.file), 'utf8').split('\n').length }; } catch {}
    const untrackedBefore = new Set(listUntracked());
    // T-124：本 delta 累计预算 + 杀树回滚回调。挂起/超时的尝试必须先回滚（执行器可能已改了一半），
    // 下一档执行器才从干净基线起步；被杀的整棵进程树不留孤儿，杜绝"事后偷偷提交"。
    const deltaDeadline = Date.now() + DELTA_BUDGET_MS;
    const onKill = (tag) => {
      rollbackExecutorChanges(baseCommit, tag);
      cleanupOrphans(untrackedBefore, tag);
    };
    // T-123 语义护栏（修复前基线）：配对回归测试在改动前先跑一遍——只有"基线绿、修复后红"
    // 才算本次回归。基线本就红（既有红测试）→ 修复后不阻塞，避免误伤正当修复。
    let semanticBaseline = null;
    if (!skipSemantic) {
      semanticBaseline = runPairedTest(join(TITAN_ROOT, delta.file), { root: TITAN_ROOT, testDir: SEMANTIC_TEST_DIR });
      if (semanticBaseline.status !== 'SKIP') {
        console.log('  语义基线(' + semanticBaseline.status + '):', semanticBaseline.detail);
      }
    }
    const exec = await runWithTimeoutChain(prompt, delta.id, { deadline: deltaDeadline, onKill });
    let { exitCode, stdout } = exec;
    const stderr = exec.stderr;

    if (exec.budgetExhausted) {
      console.log('❌ 本 delta 累计预算耗尽（' + DELTA_BUDGET_MS + 'ms）→ BLOCKED 记账');
      onKill('delta-budget');
      results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'delta-budget-exhausted', tried: exec.tried });
      continue;
    }

    if (exec.timedOutAll) {
      const hangy = exec.hungCount > 0 && exec.timeoutCount === 0;
      console.log('❌ 执行器' + (hangy ? '挂起' : '超时') + '链耗尽（重试+降档后仍失败）→ BLOCKED 记账');
      console.log('  tried:', JSON.stringify(exec.tried));
      onKill(hangy ? 'executor-hang' : 'executor-timeout');
      results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: hangy ? 'executor-hang-chain' : 'executor-timeout-chain', tried: exec.tried });
      continue;
    }

    if (exitCode !== 0) {
      // T-168：模型/provider 不可用（不是代码问题）→ 记 BLOCKED 并**中止本轮**
      // （继续跑下去 = 每条 DELTA 各烧一次几十秒的重试，9 条 = 十几分钟白等）。
      if (isProviderDownOutput((stdout || '') + (stderr || ''))) {
        const why = providerDownReason((stdout || '') + (stderr || ''));
        console.log('⛔ 执行器模型不可用: ' + why + ' → 中止本轮剩余 DELTA');
        cleanupOrphans(untrackedBefore, 'executor-model-down');
        // 把这次失败写回健康表（本地文件写，零网络）→ 下一轮 spawn 之前就能 fail fast，
        // 不用再拿死模型烧一遍额度。
        noteModelFailure({ profiles, executorName, reason: why });
        blockRemainingOnProviderDown({ acceptDeltas, doneDeltaIds, results, current: delta, reason: why });
        writeResult(dispatchId, executorName, results, 'BLOCKED', '', 3);
        trace('RESULT_WRITE', { status: 'BLOCKED', exitCode: 3, reason: 'executor-model-unavailable', detail: why });
        console.error('❌ 执行器模型不可用（' + why + '）→ 本轮中止，记 BLOCKED');
        process.exit(3);
      }
      console.log('❌ 执行器退出码:', exitCode);
      console.log('stdout:', stdout.slice(0, 500));
      console.log('stderr:', stderr.slice(0, 500));
      cleanupOrphans(untrackedBefore, 'executor-exit');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode });
      allPass = false;
      continue;
    }

    // 获取 git diff（对比本 DELTA 的基准提交）：全树用于范围检查，scoped 用于"目标必须被改"
    let full;
    let scoped;
    
    // 主路径：初始化值（后续仅在retry分支中重新赋值）
    {
      const fullTemp = gitSync(['diff', baseCommit]).stdout;
      const scopedTemp = gitSync(['diff', baseCommit, '--', delta.file]).stdout;
      full = fullTemp;
      scoped = scopedTemp;
    }

    // 协议漏报补救（实测 opencode 会用自然语言代替标记行）：空 diff 且无标记 →
    // 提醒执行器二选一（输出标记行 或 真正改文件），重试后重取 diff 再判。
    if (!scoped.trim() && !/\bALREADY_RESOLVED\b/.test(stdout)) {
      console.log('[RETRY] ' + delta.id + ' 空 diff 且未回报 ALREADY_RESOLVED，协议提醒重试一次');
      const retryPrompt = `读取并检查文件 ${delta.file}。finding：${delta.finding}。
只能二选一：
1) 该 finding 对当前代码已不成立（含被同轮前序 DELTA 修复）→ 在你 stdout 回复文本里输出单独一行：ALREADY_RESOLVED（禁止写进文件），不要改文件；并且**必须**另起一行输出强证明（否则视为未证明，判 FAIL）：
PROOF: ${delta.file}:<行号>: <该行原文片段（逐字，>=8 字符）>
2) 仍成立 → 直接修改该文件（只改它、不提交，改完直接返回；禁止改动其他任何文件）。编辑方式硬约束：最小定点替换、禁用 shell 写文件、保持 UTF-8 无 BOM/LF。`;
      const retry = await runWithTimeoutChain(retryPrompt, delta.id + '-retry', { deadline: deltaDeadline, onKill });
      if (retry.budgetExhausted) {
        results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'retry-budget-exhausted', tried: retry.tried });
        continue;
      }
      if (retry.timedOutAll) {
        results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'retry-timeout-chain', tried: retry.tried });
        continue;
      }
       if (retry.exitCode === 0) {
         stdout = retry.stdout;
         // 重试分支：使用 let 声明临时变量
         let retryFull = gitSync(['diff', baseCommit]).stdout;
         let retryScoped = gitSync(['diff', baseCommit, '--', delta.file]).stdout;
         // 赋值回外部作用域的 full/scoped
         full = retryFull;
         scoped = retryScoped;
       } else {
         console.log('  协议提醒重试失败（exit=' + retry.exitCode + '），按原输出继续判定');
       }
    }

    // 空 diff 双分支：执行器按协议显式回报 ALREADY_RESOLVED → 必须附 PROOF 强证明
// （P-12：file 一致 + 行号存在 + 该行原文逐字命中，缺一视为需修）；通过则免改 PASS
// （不提交、base 不动、stdout 尾部留档供 M4 审计）。
// T-59 试点补丁（RETRY 缺口）：首答 PROOF 无效时先发一次协议提醒重试——codestral 对小修
// 裸报 ALREADY_RESOLVED 3/3 FAIL 实录（重试把判断压力还给执行器）；重试后仍无有效证明才拒判 FAIL。
    if (!scoped.trim() && /\bALREADY_RESOLVED\b/.test(stdout)) {
      let arProof = extractAlreadyResolvedProof(stdout);
      let proofOk = proofLineMatches(join(TITAN_ROOT, delta.file), delta.file, arProof.proof);
      if (!proofOk) {
        console.log('[RETRY] ' + delta.id + ' ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次');
        const proofRetryPrompt = `读取并检查文件 ${delta.file}。你上一条回复主张 ALREADY_RESOLVED，但缺失或无效的强证明已被系统拒绝（判定规则：PROOF 行必须逐字引用该文件现存的真实行，file 一致 + 行号存在 + 原文片段 >=8 字符逐字命中）。
只能二选一：
1) 主张仍成立 → 在你 stdout 回复文本里输出单独一行：ALREADY_RESOLVED，并另起一行输出：PROOF: ${delta.file}:<行号>: <该行原文片段（逐字，>=8 字符）>（禁止写进文件，禁止改动文件）
2) 不再主张 → 直接修改该文件（只改它、不提交，改完直接返回；禁止改动其他任何文件）。编辑方式硬约束：最小定点替换、禁用 shell 写文件、保持 UTF-8 无 BOM/LF。`;
        const proofRetry = await runWithTimeoutChain(proofRetryPrompt, delta.id + '-proof-retry', { deadline: deltaDeadline, onKill });
        if (proofRetry.budgetExhausted) {
          results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'proof-retry-budget-exhausted', tried: proofRetry.tried });
          continue;
        }
        if (proofRetry.timedOutAll) {
          results.push({ deltaId: delta.id, file: delta.file, status: 'BLOCKED', exitCode: null, reason: 'proof-retry-timeout-chain', tried: proofRetry.tried });
          continue;
        }
        if (proofRetry.exitCode === 0) {
          stdout = proofRetry.stdout;
          full = gitSync(['diff', baseCommit]).stdout;
          scoped = gitSync(['diff', baseCommit, '--', delta.file]).stdout;
          arProof = extractAlreadyResolvedProof(stdout);
          proofOk = !scoped.trim() && proofLineMatches(join(TITAN_ROOT, delta.file), delta.file, arProof.proof);
        } else {
          console.log('  协议提醒重试失败（exit=' + proofRetry.exitCode + '），按原输出继续判定');
        }
      }
      // 重试后仍为"空 diff + ALREADY_RESOLVED"：按 P-12 强证明终判
      if (!scoped.trim() && /\bALREADY_RESOLVED\b/.test(stdout)) {
        if (!proofOk) {
          rollbackExecutorChanges(baseCommit, 'already-resolved-no-proof');
          cleanupOrphans(untrackedBefore, 'already-resolved-no-proof');
          results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'ALREADY_RESOLVED 无有效 PROOF（P-12 强证明：file:line:原文逐字校验不通过，视为需修）', proof: arProof.proof });
          console.log('❌', delta.id, 'ALREADY_RESOLVED 但 PROOF 无效:', JSON.stringify(arProof.proof));
          allPass = false;
          continue;
        }
        const okR = await verify(delta, full, scoped, false);
        if (!okR) {
          rollbackExecutorChanges(baseCommit, 'already-resolved-scope');
          cleanupOrphans(untrackedBefore, 'already-resolved-scope');
          results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'verify failed (already-resolved but scope violated)' });
          allPass = false;
          continue;
        }
        results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0, reason: 'ALREADY_RESOLVED (PROOF verified)', proof: arProof.proof, finding: delta.finding, action: delta.action, verifyProfile: lastVerifyProfile });
        console.log('⏭', delta.id, 'PASS (ALREADY_RESOLVED + PROOF verified @' + arProof.proof.file + ':' + arProof.proof.line + ')');
        console.log('  执行器判词:', stdout.slice(-300).replace(/\s+/g, ' '));
        continue;
      }
      // 重试后变为真修改或无标记 → 落入下方常规 verify 通道
    }

    // 验证
    const ok = await verify(delta, full, scoped);
    if (!ok) {
      console.log('  执行器输出尾部:', stdout.slice(-300).replace(/\s+/g, ' '));
      // P-23：全量回滚本 delta 执行器改动（错挂文件时旧逻辑只还原 delta.file，实改文件
      // 留脏区）；preDirty=他人未提交工作，M7 绝不碰。
      rollbackExecutorChanges(baseCommit, 'verify-fail');
      cleanupOrphans(untrackedBefore, 'verify-fail');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'verify failed', verifyProfile: lastVerifyProfile });
      allPass = false;
      continue;
    }

    // T-49 sanity 护栏：verify 只管"改没改+范围"，不管"改成了什么"。毁灭性删改
    // （文件被删成壳/被写成协议标记/语法炸）必须在此拦截回滚，不许进提交。
    const sanity = checkSanity(delta.file, preState, scoped);
    if (sanity.problems.length) {
      console.log('❌ sanity 护栏拦截:', sanity.problems.join(' ; '));
      rollbackExecutorChanges(baseCommit, 'sanity');
      cleanupOrphans(untrackedBefore, 'sanity');
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'sanity: ' + sanity.problems.join(' ; ') });
      allPass = false;
      continue;
    }

    // T-123 语义护栏：sanity 只到语法级——"改成了什么"仍无人管（T-122 e2e run#1 实录：
    // `s += i` 改成 `sum += i` 语法全绿却被自动提交）。语义正确性靠证据：
    //   (a) 配对回归测试（修复前基线对照，只有基线绿→修复后红才算本次回归）
    //   (b) 新增行未声明标识符静态检查（专抓 s→sum 这类拼写漂移）
    // 拦截即回滚不提交；无可用证据时记 SKIP（杜绝"没验证却显示 PASS"）。
    let semanticStatus = 'SKIPPED';
    if (!skipSemantic) {
      const semantic = runSemanticGuard(join(TITAN_ROOT, delta.file), {
        root: TITAN_ROOT, testDir: SEMANTIC_TEST_DIR, diffText: scoped, baseline: semanticBaseline
      });
      semanticStatus = semantic.status;
      for (const c of semantic.checks) console.log('  语义护栏', c.name, '=', c.status, ':', c.detail);
      if (semantic.problems.length) {
        console.log('❌ 语义护栏拦截:', semantic.problems.join(' ; '));
        rollbackExecutorChanges(baseCommit, 'semantic');
        cleanupOrphans(untrackedBefore, 'semantic');
        results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: 0, reason: 'semantic-guard: ' + semantic.problems.join(' ; '), semantic: semanticStatus });
        allPass = false;
        continue;
      }
    }

    // 验证通过，提交这次改动（add/commit 状态必须检查——静默失败会产生"PASS 但没提交"的假证据）
    // P-18：提交消息带 dispatchId 前缀，skip 检查同缀匹配，跨 dispatch 撞号免疫。
    const commitMsg = `[${dispatchId}][${delta.id}] fix: ${delta.finding.slice(0, 60)}`;
    const addR = gitSync(['add', delta.file]);
    if (addR.status !== 0) {
      console.log('❌ git add 失败:', (addR.stderr || '').trim());
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: addR.status, reason: 'git-add-failed' });
      allPass = false;
      continue;
    }
    const commitR = gitSync(['commit', '-m', commitMsg]);
    if (commitR.status !== 0) {
      console.log('❌ git commit 失败:', (commitR.stderr || commitR.stdout || '').trim().slice(0, 300));
      results.push({ deltaId: delta.id, file: delta.file, status: 'FAIL', exitCode: commitR.status, reason: 'git-commit-failed' });
      allPass = false;
      continue;
    }

    // 更新基准提交为最新提交
    const newBase = gitSync(['rev-parse', 'HEAD']).stdout.trim();
    baseCommit = newBase;

    // 验证通过，结果已提交
    results.push({ deltaId: delta.id, file: delta.file, status: 'PASS', exitCode: 0, semantic: semanticStatus, verifyProfile: lastVerifyProfile });
    console.log('✅', delta.id, 'PASS');
  }
}

// 写结果
const blockedCount = results.filter(r => r.status === 'BLOCKED').length;
const finalVerdict = allPass ? (blockedCount > 0 ? 'BLOCKED' : 'PASS') : 'FAIL';
const finalExit = allPass ? (blockedCount > 0 ? 3 : 0) : 1;
writeResult(dispatchId, executorName, results, finalVerdict, '', 0);
if (blockedCount > 0) console.log('⛔ BLOCKED 记账: ' + blockedCount + ' 条（超时链耗尽/降档失败，非回归失败，交人核）');
trace('EXEC_END', { verdict: finalVerdict, exitCode: finalExit, deltas: results.length, blocked: blockedCount });
process.exit(finalExit);

// 写 execute-result.json（已抽到 lib/exec-run-guard.writeExecuteResult）
function writeResult(dispatchId, executor, deltas, verifyStatus, gitDiff, exitCode) {
  const { outPath, result } = writeExecuteResult({
    root: TITAN_ROOT, dispatchId, executor, deltas, verifyStatus, exitCode,
    log: (m) => console.log(m),
  });
  trace('RESULT_WRITE', { status: verifyStatus, exitCode, deltas: result.deltas.length, path: outPath });
}