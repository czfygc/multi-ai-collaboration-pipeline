// T-173: supervisor 回归 —— 任务清单校验 / env 白名单 / 守护循环重启策略 / 计划任务探测
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeJob, readJobs, writeJobs, upsertJob, removeJob, readState, writeState, childEnv,
  runDaemon, taskExists, installScheduledTask, uninstallScheduledTask, summarizeState,
  acquireDaemonLock, releaseDaemonLock,
  DEFAULT_TASK_NAME, ENV_ALLOWLIST,
  computeBackoffMs, probePort, DEFAULT_MAX_BACKOFF_MS,
} from '../lib/supervisor.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../supervisor.mjs', import.meta.url));

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 't173-sup-'));
}

// 可控假 spawner：返回带 exitCode / on('exit') / kill 的假子进程
function fakeSpawner(behavior = {}) {
  const spawned = [];
  const fn = (cmd, args, opts) => {
    const child = {
      pid: 10000 + spawned.length,
      exitCode: null,
      killed: false,
      kill() { this.killed = true; },
      on(ev, cb) { if (ev === 'exit') this._exitCb = cb; return this; },
    };
    spawned.push({ cmd, args, opts, child });
    const b = behavior[cmd];
    if (b && b.exitCode !== undefined) {
      setImmediate(() => {
        child.exitCode = b.exitCode;
        if (child._exitCb) child._exitCb(b.exitCode);
      });
    }
    return child;
  };
  return { fn, spawned };
}

test('job 规范校验：id / command / restart / max_restarts / env 白名单', () => {
  const ok = normalizeJob({ id: 'job-1', command: ['node', 'x.mjs'], restart: 'on-failure', max_restarts: 3 });
  assert.equal(ok.id, 'job-1');
  assert.equal(ok.restart, 'on-failure');
  assert.equal(ok.max_restarts, 3);
  assert.throws(() => normalizeJob({ id: 'bad id!', command: ['node'] }), /id 非法/);
  assert.throws(() => normalizeJob({ id: 'x', command: [] }), /缺 command/);
  assert.throws(() => normalizeJob({ id: 'x', command: [''] }), /非空字符串数组/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], restart: 'sometimes' }), /restart 非法/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], max_restarts: -1 }), /max_restarts/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], env_allow: ['MY_API_KEY'] }), /疑似密钥变量/);
});

test('任务清单：upsert / list / remove（临时目录）', () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    assert.equal(readJobs(jobsPath).length, 0);
    upsertJob({ id: 'a', command: ['node', 'a.mjs'] }, { jobsPath });
    upsertJob({ id: 'b', command: ['node', 'b.mjs'], restart: 'always' }, { jobsPath });
    assert.equal(readJobs(jobsPath).length, 2);
    upsertJob({ id: 'a', label: 'renamed' }, { jobsPath });
    const jobs = readJobs(jobsPath);
    assert.equal(jobs.length, 2);
    assert.equal(jobs.find((j) => j.id === 'a').label, 'renamed');
    assert.equal(removeJob('a', { jobsPath }), true);
    assert.equal(readJobs(jobsPath).length, 1);
    assert.equal(removeJob('zzz', { jobsPath }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('子进程 env：只传白名单 + 显式允许项；密钥类不落盘', () => {
  const job = { env_allow: ['TITAN_WORKSPACE'] };
  const env = { PATH: 'x', TEMP: 't', FREELLMAPI_API_KEY: 'secret', TITAN_WORKSPACE: 'w', OTHER: 'o' };
  const out = childEnv(job, env);
  assert.equal(out.PATH, 'x');
  assert.equal(out.TITAN_WORKSPACE, 'w');
  assert.equal(out.FREELLMAPI_API_KEY, undefined, '密钥不该进子进程 env');
  assert.equal(out.OTHER, undefined);
  assert.ok(ENV_ALLOWLIST.includes('PATH'));
});

test('守护循环：restart=never 的任务退出后不再拉起，状态记 exited', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'once', command: ['fake'], restart: 'never' })], jobsPath);
    const { fn, spawned } = fakeSpawner({ fake: { exitCode: 0 } });
    await runDaemon({ jobsPath, statePath, tickMs: 10, maxTicks: 5, spawnFn: fn, ledger: null });
    const state = readState(statePath);
    assert.equal(state.jobs.once.status, 'exited');
    assert.equal(state.jobs.once.exit_code, 0);
    assert.equal(spawned.length, 1, 'never 不应重启');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：restart=on-failure 且退出码非 0 → 拉起一次；退出码 0 → 不拉起', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([
      normalizeJob({ id: 'fails', command: ['bad'], restart: 'on-failure', max_restarts: 2, backoff_ms: 0 }),
      normalizeJob({ id: 'passes', command: ['good'], restart: 'on-failure', max_restarts: 2, backoff_ms: 0 }),
    ], jobsPath);
    const { fn, spawned } = fakeSpawner({ bad: { exitCode: 1 }, good: { exitCode: 0 } });
    await runDaemon({ jobsPath, statePath, tickMs: 10, maxTicks: 12, spawnFn: fn, ledger: null });
    const badSpawns = spawned.filter((s) => s.cmd === 'bad').length;
    const goodSpawns = spawned.filter((s) => s.cmd === 'good').length;
    assert.ok(badSpawns >= 2, '失败的应被拉起（至少 2 次），实际 ' + badSpawns);
    assert.equal(goodSpawns, 1, '成功的不应被拉起');
    const state = readState(statePath);
    assert.equal(state.jobs.passes.status, 'exited');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：真实子进程被拉起并写心跳状态（不依赖假 spawner）', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'alive', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], restart: 'never' })], jobsPath);
    const res = await runDaemon({ jobsPath, statePath, alertsPath: join(dir, 'alerts.jsonl'), tickMs: 50, maxTicks: 2, ledger: null });
    assert.ok(res.ticks >= 1);
    const state = readState(statePath);
    assert.equal(state.jobs.alive.status, 'running');
    assert.ok(state.jobs.alive.pid, '应有 pid');
    assert.ok(state.jobs.alive.last_beat_at, '应有心跳时间');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('守护循环：daemon 不在清单里的 job 会被杀掉并从状态移除', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    writeJobs([normalizeJob({ id: 'tmp', command: [process.execPath, '-e', 'setInterval(()=>{},1000)'], restart: 'never' })], jobsPath);
    const promise = runDaemon({ jobsPath, statePath, alertsPath: join(dir, 'alerts.jsonl'), tickMs: 30, maxTicks: 50, ledger: null });
    await new Promise((r) => setTimeout(r, 120));
    writeJobs([], jobsPath);
    await promise;
    const state = readState(statePath);
    assert.equal(state.jobs.tmp, undefined, '移出清单后状态里不该再有它');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('计划任务：不存在时 taskExists=false；install/uninstall 成对可用（Windows）', () => {
  if (process.platform !== 'win32') return;
  const probeName = 'TITAN-Supervisor-Probe-' + Date.now();
  assert.equal(taskExists(probeName), false);
  const ins = installScheduledTask({ taskName: probeName, runNow: false });
  try {
    assert.equal(ins.ok, true, JSON.stringify(ins));
    assert.equal(taskExists(probeName), true);
  } finally {
    const del = uninstallScheduledTask(probeName);
    assert.equal(del.ok, true);
  }
  assert.equal(taskExists(probeName), false);
});

test('单实例锁：第二个守护进程拿不到锁；释放后可再拿', () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'daemon.lock');
    const first = acquireDaemonLock({ lockPath, pid: process.pid });
    assert.equal(first.ok, true);
    const second = acquireDaemonLock({ lockPath, pid: process.pid + 1 });
    assert.equal(second.ok, false, '已有存活守护进程时应拿不到锁');
    assert.equal(second.pid, process.pid);
    assert.equal(releaseDaemonLock({ lockPath, pid: process.pid }), true);
    const third = acquireDaemonLock({ lockPath, pid: process.pid + 1 });
    assert.equal(third.ok, true, '释放后应能再拿');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('状态摘要可读；状态文件原子写盘', () => {
  const dir = tmpDir();
  try {
    const statePath = join(dir, 'state.json');
    writeState({ jobs: { a: { id: 'a', status: 'running', pid: 5, restarts: 0, exit_code: null, last_beat_at: 'now' } } }, statePath);
    const text = summarizeState(readState(statePath));
    assert.ok(text.includes('a'));
    assert.ok(text.includes('running'));
    assert.ok(existsSync(statePath));
    assert.ok(!existsSync(statePath + '.tmp'), '临时文件应被 rename 掉');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────── T-389：backoff 封顶 + 端口预检 ───────────────────────────

test('T-389 computeBackoffMs：指数退避在 max_backoff_ms 处封顶，不再涨到以天计', () => {
  const job = { backoff_ms: 2000, max_backoff_ms: 60000 };
  assert.equal(computeBackoffMs(job, 1), 2000, '第 1 次 = base');
  assert.equal(computeBackoffMs(job, 2), 4000);
  assert.equal(computeBackoffMs(job, 6), 60000, '2^5*2000 = 64000 应被封顶到 60000');
  assert.equal(computeBackoffMs(job, 16), 60000, 'restarts=16 原为 18.2h，必须封顶');
  assert.equal(computeBackoffMs(job, 19), 60000, 'restarts=19 原为约 6 天，必须封顶');
});

test('T-389 computeBackoffMs：缺省上限 = DEFAULT_MAX_BACKOFF_MS（5 分钟）', () => {
  assert.equal(DEFAULT_MAX_BACKOFF_MS, 5 * 60 * 1000);
  const job = { backoff_ms: 2000 };
  assert.equal(computeBackoffMs(job, 1), 2000);
  assert.equal(computeBackoffMs(job, 20), DEFAULT_MAX_BACKOFF_MS);
  // 极端指数也不许出现 Infinity / NaN
  assert.ok(Number.isFinite(computeBackoffMs(job, 500)));
  assert.ok(Number.isFinite(computeBackoffMs(job, 100000)));
});

test('T-389 normalizeJob：max_backoff_ms 校验 + port 校验', () => {
  const j = normalizeJob({ id: 'x', command: ['node'], backoff_ms: 1000, max_backoff_ms: 30000, port: 3081 });
  assert.equal(j.max_backoff_ms, 30000);
  assert.equal(j.port, 3081);
  // 未给 port 时归一为 null，避免 undefined 落盘
  assert.equal(normalizeJob({ id: 'y', command: ['node'] }).port, null);
  assert.equal(normalizeJob({ id: 'z', command: ['node'] }).max_backoff_ms, DEFAULT_MAX_BACKOFF_MS);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], backoff_ms: 5000, max_backoff_ms: 1000 }), /不得小于 backoff_ms/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], port: 0 }), /port 必须是 1-65535/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], port: 70000 }), /port 必须是 1-65535/);
  assert.throws(() => normalizeJob({ id: 'x', command: ['node'], max_backoff_ms: -1 }), /max_backoff_ms/);
});

test('T-389 probePort：空闲端口判未占用；真实监听端口判占用', async () => {
  const net = await import('node:net');
  // 1) 找一个当前空闲端口：监听 0 让系统分配，然后立刻关闭。
  const srv0 = net.createServer();
  await new Promise((r) => srv0.listen(0, '127.0.0.1', r));
  const freePort = srv0.address().port;
  await new Promise((r) => srv0.close(r));
  const free = await probePort(freePort, { timeoutMs: 500 });
  assert.equal(free.listening, false, '刚释放的端口应判为未占用');

  // 2) 真实监听 → 判占用
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const busyPort = srv.address().port;
  try {
    const busy = await probePort(busyPort, { timeoutMs: 500 });
    assert.equal(busy.listening, true, '在听的端口必须判为占用');
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

test('T-389 守护循环：端口被占用时不 spawn，记 port_conflict + alert；端口释放后恢复拉起', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    const alertsPath = join(dir, 'alerts.jsonl');
    let busy = true;
    writeJobs([normalizeJob({ id: 'listen', command: ['fake'], restart: 'always', max_restarts: 5, backoff_ms: 0, port: 3081 })], jobsPath);
    const { fn, spawned } = fakeSpawner({ fake: { exitCode: null } });
    const fakeProbe = async () => ({ listening: busy, reason: busy ? 'connected' : 'ECONNREFUSED' });
    const fakeOwner = () => (busy ? 4242 : null);

    const promise = runDaemon({
      jobsPath, statePath, alertsPath, tickMs: 20, maxTicks: 4, spawnFn: fn, ledger: null,
      portProbe: fakeProbe, portOwner: fakeOwner,
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(spawned.length, 0, '端口被占用时绝不 spawn（避免必然的 EADDRINUSE）');
    busy = false;
    await promise;

    const state = readState(statePath);
    assert.equal(spawned.length >= 1, true, '端口释放后应恢复拉起');
    assert.ok(existsSync(alertsPath), '应写 alert 文件');
    const alerts = readFileSync(alertsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const conflictAlerts = alerts.filter((a) => a.kind === 'port_conflict');
    assert.equal(conflictAlerts.length, 1, '同一占用者只告警一次（不每 tick 刷屏），实际 ' + conflictAlerts.length);
    assert.equal(conflictAlerts[0].port, 3081);
    assert.equal(conflictAlerts[0].owner_pid, 4242);
    assert.ok(state.jobs.listen, '状态里应仍有该 job');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-389 守护循环：退避被封顶时写 backoff_capped alert', async () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    const alertsPath = join(dir, 'alerts.jsonl');
    writeJobs([normalizeJob({ id: 'crash', command: ['bad'], restart: 'always', max_restarts: 20, backoff_ms: 1, max_backoff_ms: 4 })], jobsPath);
    const { fn } = fakeSpawner({ bad: { exitCode: 1 } });
    await runDaemon({ jobsPath, statePath, alertsPath, tickMs: 5, maxTicks: 60, spawnFn: fn, ledger: null });
    const alerts = readFileSync(alertsPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const capped = alerts.filter((a) => a.kind === 'backoff_capped');
    assert.ok(capped.length >= 1, '封顶必须有痕迹，实际 0 条');
    assert.ok(capped.every((a) => a.delay_ms <= 4), '封顶后 delay 不得超过 max_backoff_ms');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('T-389 CLI：add 支持 --port / --max-backoff-ms', () => {
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const r = spawnSync(process.execPath, [CLI, 'add', 'pjob', '--', 'node', 'x.mjs',
      '--port', '3081', '--max-backoff-ms', '30000', '--jobs', jobsPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const j = readJobs(jobsPath).find((x) => x.id === 'pjob');
    assert.equal(j.port, 3081);
    assert.equal(j.max_backoff_ms, 30000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI：--help 退 0；add/list 往返（临时清单）', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(help.status, 0);
  const dir = tmpDir();
  try {
    const jobsPath = join(dir, 'jobs.json');
    const statePath = join(dir, 'state.json');
    const add = spawnSync(process.execPath, [CLI, 'add', 'cli-job', '--', 'node', 'x.mjs', '--jobs', jobsPath, '--state', statePath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(add.status, 0, add.stderr);
    const list = spawnSync(process.execPath, [CLI, 'list', '--jobs', jobsPath, '--state', statePath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(list.status, 0);
    assert.ok(list.stdout.includes('cli-job'));
    const rm = spawnSync(process.execPath, [CLI, 'remove', 'cli-job', '--jobs', jobsPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(rm.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('acquireDaemonLock: stale lock + pid reused by non-node process must be reclaimed (2026-11-16 chrome reused pid=4176)', () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'daemon.lock');
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ version: 'v1', pid: process.pid, started_at: staleIso, heartbeat_at: staleIso, token: 't' }), 'utf8');
    const r = acquireDaemonLock({ lockPath, pid: process.pid + 1, isNodePid: () => false });
    assert.equal(r.ok, true, 'stale lock with alive non-node pid (reused) must be reclaimed');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acquireDaemonLock: stale lock with alive node pid must still refuse (stuck node daemon)', () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'daemon.lock');
    const staleIso = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    writeFileSync(lockPath, JSON.stringify({ version: 'v1', pid: process.pid, started_at: staleIso, heartbeat_at: staleIso, token: 't' }), 'utf8');
    const r = acquireDaemonLock({ lockPath, pid: process.pid + 1, isNodePid: () => true });
    assert.equal(r.ok, false, 'stale lock with alive node pid must be refused');
    assert.equal(r.pid, process.pid);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('acquireDaemonLock: fresh lock refuses even when pid is non-node (heartbeat within 30s = live lock)', () => {
  const dir = tmpDir();
  try {
    const lockPath = join(dir, 'daemon.lock');
    const freshIso = new Date().toISOString();
    writeFileSync(lockPath, JSON.stringify({ version: 'v1', pid: process.pid, started_at: freshIso, heartbeat_at: freshIso, token: 't' }), 'utf8');
    const r = acquireDaemonLock({ lockPath, pid: process.pid + 1, isNodePid: () => false });
    assert.equal(r.ok, false, 'fresh lock must be refused regardless of pid identity');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
