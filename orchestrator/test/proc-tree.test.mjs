// orchestrator/test/proc-tree.test.mjs — T-124：进程树 kill / 空闲看门狗 / 挂起治理
// 覆盖三块：
//   ① runProcess 单测：正常退出、非零退出、硬超时、空闲看门狗（真挂起提前收）
//   ② killTree 语义：孙进程一并死（不留孤儿事后提交）
//   ③ 执行器级集成：假执行器挂起 → titan-execute 必须快速收尾、记 BLOCKED(executor-hang-chain)、
//      回滚半成品改动、不提交
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { runProcess, killTree } from '../lib/proc-tree.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const EXECUTOR = join(REPO_ROOT, 'orchestrator', 'titan-execute.mjs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(cmd, args, cwd, env) {
  return spawnSync(cmd, args, { cwd, env: { ...process.env, ...(env || {}) }, encoding: 'utf8' });
}

// ---------------------------------------------------------------- 模块单测

test('runProcess: normal exit captures stdout and exit code', async () => {
  const r = await runProcess({ cmd: 'node', args: ['-e', "console.log('hello-guard')"], timeoutMs: 30000 });
  assert.equal(r.exitCode, 0);
  assert.ok(r.stdout.includes('hello-guard'), 'stdout should be captured: ' + r.stdout);
  assert.equal(r.timedOut, false);
  assert.equal(r.hung, false);
});

test('runProcess: non-zero exit is reported, not swallowed', async () => {
  const r = await runProcess({ cmd: 'node', args: ['-e', 'process.exit(3)'], timeoutMs: 30000 });
  assert.equal(r.exitCode, 3);
});

test('runProcess: hard timeout kills the child and reports timedOut', async () => {
  const t0 = Date.now();
  const r = await runProcess({ cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 1500 });
  const took = Date.now() - t0;
  assert.equal(r.timedOut, true, 'timedOut must be true');
  assert.ok(took < 8000, 'must resolve promptly, took ' + took + 'ms');
});

test('runProcess: idle watchdog detects a hung process before the hard timeout', async () => {
  const t0 = Date.now();
  const r = await runProcess({ cmd: 'node', args: ['-e', 'setTimeout(()=>{}, 60000)'], timeoutMs: 0, idleMs: 1500 });
  const took = Date.now() - t0;
  assert.equal(r.hung, true, 'hung must be true');
  assert.equal(r.timedOut, false);
  assert.ok(took < 8000, 'must resolve promptly, took ' + took + 'ms');
});

test('killTree: grandchildren die with the parent (no orphan left behind)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 't124-tree-'));
  const marker = join(dir, 'growing.txt');
  const grandchild = join(dir, 'grandchild.js');
  const child = join(dir, 'parent.js');
  // 路径走环境变量：Windows 路径里的反斜杠塞进 -e 代码会被当转义序列（\U 等）吃掉
  writeFileSync(grandchild, [
    "const { appendFileSync } = require('node:fs');",
    "setInterval(() => { try { appendFileSync(process.env.MARKER_FILE, 'x'); } catch (e) {} }, 100);",
    ''
  ].join('\n'), 'utf8');
  writeFileSync(child, [
    "const { spawn } = require('node:child_process');",
    "spawn(process.execPath, [process.env.GRANDCHILD], { stdio: 'ignore', env: process.env });",
    'setTimeout(() => {}, 60000);',
    ''
  ].join('\n'), 'utf8');
  try {
    const p = spawn(process.execPath, [child], {
      stdio: 'ignore',
      env: { ...process.env, GRANDCHILD: grandchild, MARKER_FILE: marker }
    });
    await sleep(1500);
    assert.ok(existsSync(marker), 'grandchild should be writing, marker missing');
    const before = statSync(marker).size;
    assert.ok(before > 0, 'grandchild should be writing, size=' + before);
    killTree(p.pid);
    // 等待进程树彻底死亡：轮询检查 marker 文件大小不再增长（负载不敏感）
    let stableCount = 0;
    let lastSize = -1;
    let stabilized = false; // T-280 复修：稳定标志必须参与断言，否则孤儿继续写也会通过
    for (let i = 0; i < 30; i++) { // 最多等 30 * 200ms = 6s
      await sleep(200);
      const curSize = statSync(marker).size;
      if (curSize === lastSize) {
        stableCount++;
        if (stableCount >= 3) { stabilized = true; break; } // 连续 3 次（600ms）无增长视为稳定
      } else {
        stableCount = 0;
      }
      lastSize = curSize;
    }
    const afterWait = statSync(marker).size;
    // T-280 复修：断言「文件确实停止增长」，而不是只断言「文件没变小」——
    // 后者在孙进程存活（孤儿继续写）时同样成立，等于把测试要抓的 bug 放走。
    // 实测：detached 孤儿（逃出 job object）场景下 before=14 → afterWait=72、stabilized=false。
    assert.ok(stabilized, 'grandchild must be dead (file must stop growing), still growing: ' + before + ' -> ' + afterWait);
    assert.ok(afterWait >= before, 'file should not shrink: ' + before + ' -> ' + afterWait);
    // 额外验证：grandchild 进程确实已死（Windows tasklist / POSIX ps 不再可见）
    // 这里通过文件停止增长作为代理指标；若需更严可加 tasklist/ps 检查
  } finally {
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', dir], { encoding: 'utf8' });
  }
});

// ------------------------------------------------- 执行器级集成（假执行器挂起）

const TARGET = 'lib/foo.mjs';
const TARGET_SRC = [
  'export function sumTo(n) {',
  '  let s = 0;',
  '  for (let i = 1; i <= n; i++) {',
  '    s += i;',
  '  }',
  '  return s;',
  '}',
  ''
].join('\n');

const HANG_EXECUTOR = [
  "import { readFileSync, writeFileSync } from 'node:fs';",
  "const target = process.env.FAKE_TARGET || 'lib/foo.mjs';",
  "// 先留半成品改动（模拟改到一半），再挂起",
  "let src = readFileSync(target, 'utf8');",
  "src = src.replace('export function sumTo(n) {', 'export function sumTo(n) {\\n  // half-applied edit');",
  "writeFileSync(target, src, 'utf8');",
  "console.log('fake-executor: half edit written, now hanging');",
  "setTimeout(() => {}, 600000);",
  ''
].join('\n');

function scaffoldHangFixture() {
  const root = mkdtempSync(join(tmpdir(), 't124-e2e-'));
  const dispatchId = 'scan-t124hang';
  const files = {
    [TARGET]: TARGET_SRC,
    'orchestrator/test/foo.test.mjs': [
      "import { test } from 'node:test';",
      "import assert from 'node:assert';",
      "import { sumTo } from '../../lib/foo.mjs';",
      "test('sumTo', () => { assert.equal(sumTo(5), 15); });",
      ''
    ].join('\n'),
    'config/executor-profiles.json': JSON.stringify({
      opencode: { cmd: ['node', join(root, 'fake-executor.mjs')], cwd: '${TITAN_ROOT}', timeoutMs: 600000, env: {} }
    }, null, 2),
    'fake-executor.mjs': HANG_EXECUTOR,
    ['reviews/' + dispatchId + '/layer-b/delta.md']: [
      '### DELTA-001',
      '**File**: `' + TARGET + '`',
      '**Finding**: sumTo needs a look',
      '**Action**: keep behaviour',
      ''
    ].join('\n'),
    ['reviews/' + dispatchId + '/layer-b/architect-decision.md']: ['DELTA-001', 'Decision: ACCEPT', ''].join('\n')
  };
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content, 'utf8');
  }
  sh('git', ['init', '-q'], root);
  sh('git', ['config', 'user.name', 'titan-fixture'], root);
  sh('git', ['config', 'user.email', 'fixture@titan.local'], root);
  sh('git', ['add', '-A'], root);
  sh('git', ['commit', '-q', '-m', 'fixture'], root);
  return { root, dispatchId };
}

test('integration: hanging executor is killed, reported as BLOCKED, rolled back, never committed', async () => {
  const { root, dispatchId } = scaffoldHangFixture();
  try {
    const before = Number(String(sh('git', ['rev-list', '--count', 'HEAD'], root).stdout || '').trim());
    const t0 = Date.now();
    const r = await runProcess({
      cmd: 'node',
      args: [EXECUTOR, dispatchId, '--skip-baseline'],
      cwd: root,
      env: {
        ...process.env,
        D_TITAN_ROOT: root,
        FAKE_TARGET: join(root, TARGET),
        TITAN_EXEC_IDLE_MS: '2000',
        TITAN_EXEC_BACKOFF_MS: '1',
        TITAN_EXEC_DELTA_BUDGET_MS: '30000'
      },
      timeoutMs: 120000
    });
    const took = Date.now() - t0;
    const out = String(r.stdout || '') + String(r.stderr || '');
    const resPath = join(root, 'reviews', dispatchId, 'layer-b', 'execute-result.json');
    assert.ok(existsSync(resPath), 'execute-result.json must exist\n' + out);
    const res = JSON.parse(readFileSync(resPath, 'utf8'));
    assert.equal(res.verifyStatus, 'BLOCKED', 'hanging executor must be BLOCKED, not PASS/FAIL: ' + JSON.stringify(res) + '\n' + out);
    assert.ok(String(res.deltas[0].reason).includes('hang'), 'reason must mention hang: ' + res.deltas[0].reason);
    assert.ok(took < 90000, 'must finish promptly instead of hanging, took ' + took + 'ms');
    assert.equal(Number(String(sh('git', ['rev-list', '--count', 'HEAD'], root).stdout || '').trim()), before, 'no commit allowed');
    const src = readFileSync(join(root, TARGET), 'utf8');
    assert.ok(!src.includes('half-applied edit'), 'half-applied edit must be rolled back: ' + src);
  } finally {
    spawnSync('cmd', ['/c', 'rmdir', '/s', '/q', root], { encoding: 'utf8' });
  }
});
