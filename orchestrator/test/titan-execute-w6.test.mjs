// orchestrator/test/titan-execute-w6.test.mjs — T-56 W6（P-11/P-12）端到端（landmine-001 沙箱）
// 前置：test-projects/landmine-001 是独立 git 测试仓（D_TITAN_ROOT 重定向，T-41 机制）；
// 本测试只在其内新增 untracked fixture（start 前就绪 → titan-execute 的 preDirty 豁免），
// 无 commit 产生；结束清理回原状（不动其历史与既有脏区）。
// 契约：
//   A. 超时 → 退避 → 降档（kilo fake）→ ALREADY_RESOLVED + PROOF 逐字校验 → PASS exit 0
//   （覆盖 P-11 全链 + P-12 强证明真 fixture）
//   B. 全链超时耗尽 → BLOCKED 记账 exit 3
//   C. PROOF 无效（无 PROOF 行）→ 协议提醒重试一次仍无效 → FAIL（P-12 假 fixture）
//   D. 首答无 PROOF → 重试后二次强证明 → PASS exit 0（T-59 RETRY 缺口补丁锁定）
//   E.（T-168）挂死类：假执行器静默挂起 → 进程自己退出 + 结果落盘 + 检查点指明挂在哪一步（零额度、秒级）
//
// 注意：E 组必须与 A~D **同文件**——node --test 按**文件**并行跑，跨文件会同时写
// test-projects/landmine-001/config/executor-profiles.json（沙箱共享）→ 互相覆盖 → 假失败。
// 同文件内串行，无此冲突。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ORCH = join(dirname(fileURLToPath(import.meta.url)), '..');
const LAND = join(ORCH, '..', 'test-projects', 'landmine-001');
const TE = join(ORCH, 'titan-execute.mjs');
const CFG = join(LAND, 'config', 'executor-profiles.json');
// 发布树不打包 241MB 沙箱仓（test-projects/landmine-001 本地 git 测试仓）：
// 沙箱缺失时整套 e2e 自动 skip，gate 仍绿；repo 内沙箱在则 4/4 照跑。
const SANDBOX_OK = existsSync(CFG);
const origCfg = SANDBOX_OK ? readFileSync(CFG, 'utf8') : '';
const SKIP = SANDBOX_OK ? false : 'sandbox test-projects/landmine-001 not bundled (241MB, local-only)';

const RSA = () => Math.random().toString(16).slice(2, 10);
const fixtures = [];

function writeFixtureProfile(...profiles) {
  const doc = {};
  for (const p of profiles) doc[p.name] = p.profile;
  writeFileSync(CFG, JSON.stringify(doc, null, 2), 'utf8');
}

const createdIds = [];
function setupDispatch(id) {
  createdIds.push(id);
  const dir = join(LAND, 'reviews', id, 'layer-b');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'delta.md'), '### DELTA-001\n**文件** target.js\n**发现** 需要修复\n**动作** 修复它\n', 'utf8');
  writeFileSync(join(dir, 'architect-decision.md'), 'DELTA-001\nDecision: ACCEPT\n', 'utf8');
  writeFileSync(join(LAND, 'target.js'), '// fixture line 1\n// fixture line 2\nconst proofTarget = true; // fixture proof line\n// fixture line 4\n', 'utf8');
}

function runExec(id, executor, env = {}) {
  return spawnSync(process.execPath, [TE, id, '--executor', executor, '--skip-baseline'], {
    cwd: LAND,
    encoding: 'utf8',
    timeout: 120000,
    env: { ...process.env, D_TITAN_ROOT: LAND, TITAN_EXEC_TIMEOUT_MS: '600', TITAN_EXEC_BACKOFF_MS: '120', ...env },
  });
}

before(() => {
  if (!SANDBOX_OK) return;
  // 沙箱 fixture 脚本（slow = 只挂起不输出；already = 输出 AR+PROOF；noproof = AR 无 PROOF；
  // proofretry = 有状态：首答 AR 无 PROOF、二次答 AR+PROOF，T-59）
  writeFileSync(join(LAND, 'slow.mjs'), 'setTimeout(()=>process.exit(0), 20000);\n', 'utf8');
  writeFileSync(join(LAND, 'already.mjs'), 'console.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nconsole.log("PROOF: target.js:3: const proofTarget = true; // fixture proof line");\nprocess.exit(0);\n', 'utf8');
  writeFileSync(join(LAND, 'noproof.mjs'), 'console.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nprocess.exit(0);\n', 'utf8');
  writeFileSync(join(LAND, 'proofretry.mjs'), 'import { existsSync, writeFileSync, mkdirSync } from "node:fs";\nimport { join } from "node:path";\nconst dir = join(process.cwd(), "tmp");\nmkdirSync(dir, { recursive: true });\nconst flag = join(dir, "proofretry.flag");\nif (!existsSync(flag)) { writeFileSync(flag, "1"); console.log("该 finding 已被同轮修复。"); console.log("ALREADY_RESOLVED"); process.exit(0); }\nconsole.log("该 finding 已被同轮修复。");\nconsole.log("ALREADY_RESOLVED");\nconsole.log("PROOF: target.js:3: const proofTarget = true; // fixture proof line");\nprocess.exit(0);\n', 'utf8');
  rmSync(join(LAND, 'tmp', 'proofretry.flag'), { force: true });
  // T-168 E 组：hang = 静默挂起（活着但哑了）——模拟"子进程不输出也不退出"
  writeFileSync(join(LAND, 'hang.mjs'), 'setTimeout(() => {}, 60000);\n', 'utf8');
  fixtures.push('slow.mjs', 'already.mjs', 'noproof.mjs', 'proofretry.mjs', 'hang.mjs', 'target.js');
});

after(() => {
  if (!SANDBOX_OK) return;
  writeFileSync(CFG, origCfg, 'utf8');
  for (const f of fixtures) { try { rmSync(join(LAND, f), { force: true }); } catch {} }
  // 只清本测试创建的 dispatch 目录（reviews 下既有 T-41 遗产都要保留）
  for (const id of createdIds) { try { rmSync(join(LAND, 'reviews', id), { recursive: true, force: true }); } catch {} }
  // proofretry 状态旗标（landmine tmp/ 内，scope 豁免区）清掉
  try { rmSync(join(LAND, 'tmp', 'proofretry.flag'), { force: true }); } catch {}
  // 本测试 spawn titan-execute 产生的 tmp 留档 prompt 也清掉（CreationTime 一分钟内的）
  const tmpDir = join(LAND, 'tmp');
  try {
    for (const f of readdirSync(tmpDir)) {
      if (!f.startsWith('titan-prompt-DELTA-001-')) continue;
      const p = join(tmpDir, f);
      try { if (Date.now() - statSync(p).mtimeMs < 3600000) rmSync(p, { force: true }); } catch {}
    }
  } catch {}
});

test('A. 超时→退避→降档→AR+PROOF 强证明真 fixture → PASS exit 0（P-11 全链 + P-12）', { skip: SKIP }, () => {
  const id = 'w6a' + RSA();
  setupDispatch(id);
  writeFixtureProfile(
    {
      name: 'test-slow',
      profile: { cmd: [process.execPath, 'slow.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
    },
    {
      name: 'kilo',
      profile: { cmd: [process.execPath, 'already.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
    }
  );
  const r = runExec(id, 'test-slow');
  assert.equal(r.status, 0, '应 PASS exit 0\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/\[TIMEOUT\]/.test(r.stdout), '应出现超时退避日志');
  assert.ok(/PASS \(ALREADY_RESOLVED \+ PROOF verified @target\.js:3\)/.test(r.stdout), '应打印 PROOF 验证通过\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'PASS');
  assert.equal(result.deltas[0].status, 'PASS');
  assert.ok(/PROOF/.test(JSON.stringify(result.deltas[0].reason || '')), 'reason 应记 PROOF 验证');
});

test('B. 全链超时耗尽 → BLOCKED 记账 exit 3', { skip: SKIP }, () => {
  const id = 'w6b' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-slow',
    profile: { cmd: [process.execPath, 'slow.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-slow');
  assert.equal(r.status, 3, '应 BLOCKED exit 3\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/BLOCKED 记账/.test(r.stdout), '应打印 BLOCKED 记账');
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'BLOCKED');
  assert.equal(result.deltas[0].status, 'BLOCKED');
});

test('C. AR 无 PROOF（假 fixture）→ FAIL（P-12 视为需修）', { skip: SKIP }, () => {
  const id = 'w6c' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-noproof',
    profile: { cmd: [process.execPath, 'noproof.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-noproof');
  assert.equal(r.status, 1, '应 FAIL exit 1\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次/.test(r.stdout), '应先触发协议提醒重试\n' + r.stdout);
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效/.test(r.stdout), '应打印 PROOF 无效\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'FAIL');
  assert.ok(/P-12/.test(result.deltas[0].reason || ''), 'reason 应标注 P-12');
});

test('D. 首答 AR 无 PROOF → 协议提醒重试 → 二次强证明 → PASS exit 0（T-59 RETRY 补丁）', { skip: SKIP }, () => {
  const id = 'w6d' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-proofretry',
    profile: { cmd: [process.execPath, 'proofretry.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const r = runExec(id, 'test-proofretry');
  assert.equal(r.status, 0, '应 PASS exit 0\n' + (r.stdout || '') + (r.stderr || ''));
  assert.ok(/ALREADY_RESOLVED 但 PROOF 无效，协议提醒重试一次/.test(r.stdout), '应出现协议提醒重试日志\n' + r.stdout);
  assert.ok(/PASS \(ALREADY_RESOLVED \+ PROOF verified @target\.js:3\)/.test(r.stdout), '重试后应 PROOF 验证通过\n' + r.stdout);
  const result = JSON.parse(readFileSync(join(LAND, 'reviews', id, 'layer-b', 'execute-result.json'), 'utf8'));
  assert.equal(result.verifyStatus, 'PASS');
  assert.equal(result.deltas[0].status, 'PASS');
});

// ── T-168 E/F 组：挂死类 bug 的**本地零额度复现**（反馈回路）────────────────
// 背景：2026-10-22 implement 阶段挂死且不落任何产物，原作者用真模型盲跑复现（烧额度）→ 定位不了。
// 本组用假执行器（hang.mjs：活着但哑了）秒级复现，并断言三件事：
//   ① 进程自己退出（预算在管事，不是永远挂着）；② 结果落盘且记 BLOCKED；③ 检查点指明挂在哪一步。

test('E.（T-168）挂死类：假执行器静默挂起 → 进程自己退出 + 结果落盘 + 检查点指明挂在哪一步（零额度、秒级）', { skip: SKIP }, () => {
  const id = 'w6e' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-hang',
    profile: { cmd: [process.execPath, 'hang.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const t0 = Date.now();
  const r = runExec(id, 'test-hang', { TITAN_EXEC_TIMEOUT_MS: '3000', TITAN_EXEC_IDLE_MS: '800', TITAN_EXEC_BACKOFF_MS: '50', TITAN_EXEC_MAX_WALL_MS: '6000' });
  const elapsed = Date.now() - t0;

  // ① 必须自己退出（不是永远挂着）
  assert.ok(elapsed < 45000, '挂死场景必须在预算内自行退出，实际 ' + elapsed + 'ms\n' + (r.stdout || '') + (r.stderr || ''));
  assert.notEqual(r.status, null, '不应被外部强杀（说明是我们自己的预算在管事）');

  // ② 结果必须落盘（原来挂死时只有 executor-command.txt，没有 execute-result.json）
  const resultPath = join(LAND, 'reviews', id, 'layer-b', 'execute-result.json');
  assert.ok(existsSync(resultPath), 'execute-result.json 必须落盘（挂死时外层要拿得到结果）\n' + (r.stdout || ''));
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.verifyStatus, 'BLOCKED', '静默挂起应记 BLOCKED（不是回归失败，也不是假 PASS）');

  // ③ 检查点必须指明挂在哪一步：哪个执行器、是否 hung、耗时多少
  const tracePath = join(LAND, 'reviews', id, 'executor-trace.jsonl');
  assert.ok(existsSync(tracePath), 'executor-trace.jsonl 必须落盘（定位挂死点的唯一手段）');
  const events = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const spawnEv = events.find((e) => e.event === 'EXECUTOR_SPAWN');
  assert.ok(spawnEv, '检查点必须含 EXECUTOR_SPAWN');
  assert.equal(spawnEv.executor, 'test-hang', '检查点必须指明是哪个执行器挂的');
  const exitEv = events.find((e) => e.event === 'EXECUTOR_EXIT');
  assert.ok(exitEv, '检查点必须含 EXECUTOR_EXIT（看门狗杀树后要留痕）');
  assert.equal(exitEv.hung, true, '检查点必须标明这次是挂起（hung=true），不是普通退出');
  assert.ok(events.some((e) => e.event === 'RESULT_WRITE'), '检查点必须含 RESULT_WRITE');
});

test('F.（T-168）全局墙钟预算到点即止链（9 条 DELTA × 每条 600s 的老问题不再存在）', { skip: SKIP }, () => {
  const id = 'w6f' + RSA();
  setupDispatch(id);
  writeFixtureProfile({
    name: 'test-hang',
    profile: { cmd: [process.execPath, 'hang.mjs'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 600000 },
  });
  const t0 = Date.now();
  const r = runExec(id, 'test-hang', { TITAN_EXEC_MAX_WALL_MS: '1500', TITAN_EXEC_IDLE_MS: '4000', TITAN_EXEC_TIMEOUT_MS: '5000' });
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 30000, '全局墙钟到点必须止链，实际 ' + elapsed + 'ms');
  const resultPath = join(LAND, 'reviews', id, 'layer-b', 'execute-result.json');
  assert.ok(existsSync(resultPath), '到点也必须落盘结果');
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(result.verifyStatus, 'BLOCKED');
  const reasons = JSON.stringify(result.deltas.map((d) => d.reason || ''));
  assert.ok(/wall-budget|hang|timeout/i.test(reasons), '结果必须记账是墙钟/挂起/超时原因：' + reasons);
});

// G.（T-168 独立复核发现，四席均未报）"没东西可做" ≠ "成功"——
// 输入其实没生成完（占位/空文件/无裁决）却报 PASS，正是"stage 卡在 46% 还显示成功"的假成功面。
test('G.（T-168 复核）delta 占位/空文件/无裁决 → BLOCKED 不报 PASS；真·全 REJECT 仍 PASS', { skip: SKIP }, () => {
  writeFixtureProfile({
    name: 'test-idle',
    profile: { cmd: [process.execPath, '-e', 'process.exit(0)'], modelFlag: '--model', defaultModel: 'x', extraArgs: [], env: {}, cwd: '.', timeoutMs: 5000 },
  });
  const mk = (id, delta, dec) => {
    createdIds.push(id);
    const dir = join(LAND, 'reviews', id, 'layer-b');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'delta.md'), delta, 'utf8');
    writeFileSync(join(dir, 'architect-decision.md'), dec, 'utf8');
    return join(dir, 'execute-result.json');
  };
  const readTrace = (id) => {
    const p = join(LAND, 'reviews', id, 'executor-trace.jsonl');
    return existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  // ① STEP A 占位 delta（analyze 根本没跑）→ 必须 BLOCKED
  const placeholder = '# Layer B — delta\n\n<!-- STEP A 阶段仅占位。冲突检测、盲点分级、过滤器审计由 STEP B 填充。 -->\n\n## DELTA 项\n\n_（STEP B 填充）_\n';
  const id1 = 'w6g1' + RSA();
  const p1 = mk(id1, placeholder, 'x');
  const r1 = runExec(id1, 'test-idle');
  assert.equal(r1.status, 3, '占位 delta 必须 exit 3（不能报成功），实际 ' + r1.status + '\n' + r1.stdout + r1.stderr);
  const res1 = JSON.parse(readFileSync(p1, 'utf8'));
  assert.equal(res1.verifyStatus, 'BLOCKED', '占位 delta 必须 BLOCKED，不是 PASS');
  assert.ok(res1.deltas.some((d) => d.reason === 'delta-placeholder'), '必须记账 delta-placeholder：' + JSON.stringify(res1.deltas));
  assert.ok(readTrace(id1).some((e) => e.event === 'DELTA_INPUT_BROKEN' && e.reason === 'delta-placeholder'), '检查点必须留 DELTA_INPUT_BROKEN');

  // ② delta.md 空文件（写入中断）→ 必须 BLOCKED
  const id2 = 'w6g2' + RSA();
  const p2 = mk(id2, '', 'DELTA-001\nDecision: REJECT\n');
  const r2 = runExec(id2, 'test-idle');
  assert.equal(r2.status, 3, '空 delta 必须 exit 3，实际 ' + r2.status + '\n' + r2.stdout);
  const res2 = JSON.parse(readFileSync(p2, 'utf8'));
  assert.equal(res2.verifyStatus, 'BLOCKED');
  assert.ok(res2.deltas.some((d) => d.reason === 'delta-empty'), '必须记账 delta-empty：' + JSON.stringify(res2.deltas));

  // ③ 有 DELTA 但裁决文件一条 DELTA 都没有（architect 没裁决）→ 必须 BLOCKED
  const id3 = 'w6g3' + RSA();
  const p3 = mk(id3, '### DELTA-001\n**文件** target.js\n**发现** x\n**动作** y\n', '# 架构裁决\n\n本轮暂无结论。\n');
  const r3 = runExec(id3, 'test-idle');
  assert.equal(r3.status, 3, '缺裁决必须 exit 3，实际 ' + r3.status + '\n' + r3.stdout);
  const res3 = JSON.parse(readFileSync(p3, 'utf8'));
  assert.equal(res3.verifyStatus, 'BLOCKED');
  assert.ok(res3.deltas.some((d) => d.reason === 'architect-decision-missing'), '必须记账 architect-decision-missing：' + JSON.stringify(res3.deltas));

  // ④ 对照组：有 DELTA、有裁决、全 REJECT → 这是**合法**的"无事可做"，仍必须 PASS（不许误伤）
  const id4 = 'w6g4' + RSA();
  const p4 = mk(id4, '### DELTA-001\n**文件** target.js\n**发现** x\n**动作** y\n', 'DELTA-001\nDecision: REJECT\n');
  const r4 = runExec(id4, 'test-idle');
  assert.equal(r4.status, 0, '全 REJECT 是合法无事可做，必须 PASS exit 0，实际 ' + r4.status + '\n' + r4.stdout + r4.stderr);
  const res4 = JSON.parse(readFileSync(p4, 'utf8'));
  assert.equal(res4.verifyStatus, 'PASS', '全 REJECT 不许被误判成 BLOCKED');
});