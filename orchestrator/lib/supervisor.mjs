// orchestrator/lib/supervisor.mjs — T-173 常驻子进程监督器（解"后台进程被会话清理链杀"）
//
// 本模块职责：
//   1. **守护循环**：按任务清单 spawn 子进程，监控退出，按重启策略拉起（指数退避），写心跳/状态；
//   2. **落状态**：state.json + alerts.jsonl（失败不再静默）；
//   3. **装常驻**：schtasks 计划任务（跨会话存活）。
//
// 加固（T-173 复盘，吸收"真服务监督"优点而全 Node 化，无外部 winsw/NSSM）：
//   A. spawn 同步抛异常 + 子进程 'error' 事件 → 只废掉该 job，不拖死整个守护进程；
//   B. 子进程 stdout/stderr 常驻排空（上限 256KB），根治">64KB 即挂死"；
//   C. 重启计数存入 state 并重生成沿用 → max_restarts 真正生效（跨守护重启也沿用）；
//   D. 重生时清旧 exit_code，杜绝"status=running 却 exit_code=1"假状态；
//   E. 单实例锁 heartbeat + stale 接管，防两个 daemon 抢同一 job；
//   F. alerts.jsonl 告警通道，修复"失败静默不可见"。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, appendFileSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { connect as netConnect } from 'node:net';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_SUPERVISOR_DIR = join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor');
export const DEFAULT_JOBS_PATH = join(DEFAULT_SUPERVISOR_DIR, 'jobs.json');
export const DEFAULT_STATE_PATH = join(DEFAULT_SUPERVISOR_DIR, 'state.json');
export const DEFAULT_ALERTS_PATH = join(DEFAULT_SUPERVISOR_DIR, 'alerts.jsonl');
export const DEFAULT_TASK_NAME = 'TITAN-Supervisor';
export const RESTART_POLICIES = Object.freeze(['always', 'on-failure', 'never']);
export const JOB_STATUSES = Object.freeze(['running', 'exited', 'restarting', 'failed', 'stopped', 'port_conflict']);

export const STALE_LOCK_MS = 30000;
export const CHILD_OUTPUT_CAP = 256 * 1024;

// T-432/T-429: 真实 spawn 时子进程 stdout/stderr 直接落盘 <supervisor 目录>/logs/<jobId>.out|err.log，
// 绕开管道——管道只活在 supervisor 内存里，supervisor 一旦被杀，子进程写 stderr 即 EPIPE 静默死亡（1888 空 stderr exit 1 的成因）。
// 文件是子进程自己写的，管道根本不存在，杀手再怎么杀 supervisor，孩子日志也不会丢。
// 文件 > 5 MB 时滚动为 .1（覆盖）；spawn 前滚动。
const JOB_LOG_ROTATE_BYTES = 5 * 1024 * 1024;
const JOB_LOG_TAIL_BYTES = 8192;
function rotateIfLarge(p) {
  try {
    if (statSync(p).size > JOB_LOG_ROTATE_BYTES) renameSync(p, p + '.1');
  } catch { /* absent or unstattable */ }
}
function readTailFile(file, maxBytes = JOB_LOG_TAIL_BYTES) {
  try {
    const st = statSync(file);
    const len = Math.min(st.size, maxBytes);
    if (len <= 0) return '';
    const fd = openSync(file, 'r');
    const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, st.size - len); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
}
// T-389：退避封顶。原实现 delay = backoff_ms * 2^(restarts-1) 无上限，
// restarts=16 -> 18.2h、restarts=19 -> ~6 天，端口冲突类失败会静默等成"永久不拉起"。
export const DEFAULT_MAX_BACKOFF_MS = 5 * 60 * 1000;
// T-389：spawn 前端口预检的超时（localhost connect 探测，超时视为未占用）。
export const PORT_PROBE_TIMEOUT_MS = 1000;

export const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'SystemRoot', 'windir',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'USERNAME', 'TITAN_WORKSPACE',
]);

function ensureDir(path) { mkdirSync(path, { recursive: true }); return path; }

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(path, value) {
  ensureDir(path.replace(/[\\/][^\\/]+$/, ''));
  // pid + 随机后缀防撞（与 dispatch.mjs writeQueueLocked 同模式）
  const tmp = path + '.' + process.pid + '.' + randomUUID().slice(0, 8) + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

function typeofNow(now) {
  return typeof now === 'function' ? now() : (typeof now === 'number' ? now : Date.now());
}

export function normalizeJob(spec, { existing = null } = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('job 必须是对象');
  const id = String(spec.id || (existing && existing.id) || '').trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error('job id 非法（只允许字母数字 . _ -，1-64 字符）: ' + id);
  const command = spec.command || (existing && existing.command);
  if (!Array.isArray(command) || !command.length) throw new Error('job ' + id + ' 缺 command（字符串数组）');
  if (!command.every((c) => typeof c === 'string' && c.length)) throw new Error('job ' + id + ' 的 command 必须是非空字符串数组');
  const restart = spec.restart || (existing && existing.restart) || 'on-failure';
  if (!RESTART_POLICIES.includes(restart)) throw new Error('job ' + id + ' 的 restart 非法: ' + restart);
  const maxRestarts = Number(spec.max_restarts ?? (existing && existing.max_restarts) ?? 5);
  if (!Number.isInteger(maxRestarts) || maxRestarts < 0) throw new Error('job ' + id + ' 的 max_restarts 必须是非负整数');
  const backoffMs = Number(spec.backoff_ms ?? (existing && existing.backoff_ms) ?? 2000);
  if (!Number.isInteger(backoffMs) || backoffMs < 0) throw new Error('job ' + id + ' 的 backoff_ms 必须是非负整数');
  // T-389：退避上限。缺省 DEFAULT_MAX_BACKOFF_MS（5 分钟）；显式值不得小于 backoff_ms。
  const maxBackoffMs = Number(spec.max_backoff_ms ?? (existing && existing.max_backoff_ms) ?? DEFAULT_MAX_BACKOFF_MS);
  if (!Number.isInteger(maxBackoffMs) || maxBackoffMs < 0) throw new Error('job ' + id + ' 的 max_backoff_ms 必须是非负整数');
  if (maxBackoffMs < backoffMs) throw new Error('job ' + id + ' 的 max_backoff_ms(' + maxBackoffMs + ') 不得小于 backoff_ms(' + backoffMs + ')');
  // T-389：可选端口预检。给了 port 就在 spawn 前探测本机是否已被占用。
  let port = null;
  if (spec.port !== undefined && spec.port !== null) {
    const p = Number(spec.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('job ' + id + ' 的 port 必须是 1-65535 的整数');
    port = p;
  } else if (existing && existing.port) {
    port = existing.port;
  }
  const envAllow = Array.isArray(spec.env_allow) ? spec.env_allow.filter((k) => typeof k === 'string') : [];
  const forbidden = envAllow.filter((k) => /pass|secret|token|api[_-]?key|credential/i.test(k));
  if (forbidden.length) throw new Error('job ' + id + ' 的 env_allow 含疑似密钥变量（不许落盘）: ' + forbidden.join(','));
  return {
    id,
    label: String(spec.label || (existing && existing.label) || id),
    command,
    cwd: String(spec.cwd || (existing && existing.cwd) || REPO_ROOT),
    restart,
    max_restarts: maxRestarts,
    backoff_ms: backoffMs,
    max_backoff_ms: maxBackoffMs,
    port,
    env_allow: envAllow,
    enabled: spec.enabled === undefined ? (existing ? existing.enabled !== false : true) : spec.enabled !== false,
  };
}

export function readJobs(jobsPath = DEFAULT_JOBS_PATH) {
  const j = readJson(jobsPath, { version: 'v1', jobs: [] });
  return Array.isArray(j.jobs) ? j.jobs : [];
}

export function writeJobs(jobs, jobsPath = DEFAULT_JOBS_PATH) {
  writeJsonAtomic(jobsPath, { version: 'v1', updated_at: new Date().toISOString(), jobs });
  return jobsPath;
}

export function upsertJob(spec, { jobsPath = DEFAULT_JOBS_PATH } = {}) {
  const jobs = readJobs(jobsPath);
  const idx = jobs.findIndex((j) => j.id === String(spec.id || ''));
  const job = normalizeJob(spec, { existing: idx >= 0 ? jobs[idx] : null });
  if (idx >= 0) jobs[idx] = job; else jobs.push(job);
  writeJobs(jobs, jobsPath);
  return job;
}

export function removeJob(id, { jobsPath = DEFAULT_JOBS_PATH } = {}) {
  const jobs = readJobs(jobsPath);
  const next = jobs.filter((j) => j.id !== id);
  writeJobs(next, jobsPath);
  return next.length !== jobs.length;
}

export function readState(statePath = DEFAULT_STATE_PATH) {
  return readJson(statePath, { version: 'v1', updated_at: null, jobs: {} });
}

export function writeState(state, statePath = DEFAULT_STATE_PATH) {
  state.version = 'v1';
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  return state;
}

export function childEnv(job, env = process.env) {
  const out = {};
  for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) out[k] = env[k];
  for (const k of (job.env_allow || [])) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

function appendAlert(alertsPath, kind, data) {
  if (!alertsPath) return false;
  try {
    ensureDir(alertsPath.replace(/[\\/][^\\/]+$/, ''));
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), kind }, data)) + '\n';
    appendFileSync(alertsPath, line, 'utf8');
    return true;
  } catch { return false; }
}

// T-389：带封顶的退避计算。restarts 从 1 开始计（第 1 次重启 = backoff_ms * 2^0）。
// 上限 job.max_backoff_ms（缺省 DEFAULT_MAX_BACKOFF_MS），并且对超大指数做保护，
// 避免 Math.pow(2, 1000) = Infinity 造成 next_start_at 变成 Invalid Date。
export function computeBackoffMs(job, restarts) {
  const base = Math.max(0, Number(job && job.backoff_ms) || 0);
  const capRaw = job && job.max_backoff_ms !== undefined && job.max_backoff_ms !== null
    ? Number(job.max_backoff_ms) : DEFAULT_MAX_BACKOFF_MS;
  const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : DEFAULT_MAX_BACKOFF_MS;
  const n = Math.max(1, Number(restarts) || 1);
  // 2^(n-1) 在 n>31 时早已超过任何合理上限，直接取 cap，省掉无意义的浮点计算。
  const exp = n - 1;
  const raw = exp > 31 ? Infinity : base * Math.pow(2, exp);
  return Math.min(cap, raw);
}

// T-389：本机端口占用探测。连得上（或明确 ECONNREFUSED 之外的其他结果）视为被占用。
// 只探测 127.0.0.1，不触网；超时/ECONNREFUSED/EHOSTUNREACH 视为未占用。
export function probePort(port, { timeoutMs = PORT_PROBE_TIMEOUT_MS, host = '127.0.0.1' } = {}) {
  return new Promise((resolvePromise) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) { resolvePromise({ listening: false, reason: 'invalid_port' }); return; }
    let settled = false;
    const done = (listening, reason) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 忽略 */ }
      resolvePromise({ listening, reason });
    };
    const sock = netConnect({ port, host });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true, 'connected'));
    sock.once('timeout', () => done(false, 'timeout'));
    sock.once('error', (err) => {
      const code = err && err.code;
      // ECONNREFUSED = 没有监听者；EADDRNOTAVAIL/EHOSTUNREACH 同样视为无人监听。
      if (code === 'ECONNREFUSED' || code === 'EADDRNOTAVAIL' || code === 'EHOSTUNREACH') done(false, code);
      else done(true, code || 'error');
    });
  });
}

// T-389：找出占用某端口的进程 pid（尽力而为；Windows 走 Get-NetTCPConnection，其他平台返回 null）。
export function findPortOwnerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`],
      { encoding: 'utf8', timeout: 5000, windowsHide: true });
    const pid = Number(String(r.stdout || '').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch { return null; }
}

export async function runDaemon({
  jobsPath = DEFAULT_JOBS_PATH, statePath = DEFAULT_STATE_PATH,
  alertsPath = null, onHeartbeat = null,
  tickMs = 2000, maxTicks = Infinity, spawnFn = null, ledger = null, env = process.env, now = () => Date.now(),
  portProbe = probePort, portOwner = findPortOwnerPid,
} = {}) {
  const spawnChild = spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
  const children = new Map();
  const prev = readState(statePath);
  const state = { version: 'v1', updated_at: null, jobs: prev.jobs || {} };
  let ticks = 0;

  const snapshot = () => {
    const s = { version: 'v1', updated_at: new Date().toISOString(), jobs: {} };
    for (const job of readJobs(jobsPath)) {
      const c = children.get(job.id);
      const st = state.jobs[job.id] || {};
      s.jobs[job.id] = {
        id: job.id, label: job.label, status: st.status || 'stopped',
        pid: c && c.child.pid ? c.child.pid : (st.pid || null),
        started_at: c ? c.startedAt : (st.started_at || null),
        last_beat_at: st.last_beat_at || null,
        exit_code: st.exit_code === undefined ? null : st.exit_code,
        restarts: c ? c.restarts : (st.restarts || 0),
        last_error: st.last_error || null,
        // T-389：端口冲突相关字段需落盘，否则 daemon 重启后重复告警 / 摘要看不到占用者。
        ...(st.port !== undefined ? { port: st.port } : {}),
        ...(st.port_owner_pid !== undefined && st.port_owner_pid !== null ? { port_owner_pid: st.port_owner_pid } : {}),
        ...(st.conflict_seen_at ? { conflict_seen_at: st.conflict_seen_at } : {}),
        ...(st.alert_key ? { alert_key: st.alert_key } : {}),
      };
    }
    return s;
  };

  while (ticks < maxTicks) {
    ticks += 1;
    if (typeof onHeartbeat === 'function') { try { onHeartbeat(); } catch { /* 忽略 */ } }
    const jobs = readJobs(jobsPath);
    for (const job of jobs) {
      if (!job.enabled) continue;
      const entry = (state.jobs[job.id] || { status: 'stopped', restarts: 0 });
      let c = children.get(job.id);

      if (c && c.pending) {
        if (now() < c.nextStartAt) { state.jobs[job.id] = entry; continue; }
        children.delete(job.id);
        c = null;
      }

      if (c && c.child.exitCode !== null) {
        if (!c.recorded) {
          c.recorded = true;
          const code = c.child.exitCode;
          const memStderr = (c.output && c.output.stderr) ? c.output.stderr.slice(-800) : '';
          const fileStderr = memStderr ? '' : (c.logFiles && c.logFiles.err ? readTailFile(c.logFiles.err).replace(/\s+$/g, '').trim() : '');
          const isFileMode = !!(c.logFiles && c.logFiles.err);
          const error = c.spawnError
            || (code !== 0 && memStderr ? memStderr : null)
            || (code !== 0 && fileStderr ? fileStderr.slice(-800) : null)
            || (code !== 0 && isFileMode
              ? 'exit_code=' + code + '（无 stderr 输出；见 ' + c.logFiles.err + '）'
              : null);
          entry.status = 'exited';
          entry.exit_code = code;
          entry.last_beat_at = new Date().toISOString();
          if (error) entry.last_error = error;
          if (ledger && ledger.append) ledger.append('supervisor', 'task.end', { job: job.id, exit_code: code, restarts: c.restarts, error });
          appendAlert(alertsPath, 'task.end', { job: job.id, exit_code: code, restarts: c.restarts, error });
          const shouldRestart = job.restart === 'always' || (job.restart === 'on-failure' && code !== 0);
          if (shouldRestart && c.restarts < job.max_restarts) {
            c.restarts += 1;
            entry.restarts = c.restarts;
            entry.status = 'restarting';
            const delay = computeBackoffMs(job, c.restarts);
            c.pending = true;
            c.nextStartAt = now() + delay;
            entry.next_start_at = new Date(c.nextStartAt).toISOString();
            // T-389：退避被封顶截断时留痕，避免"看起来永久不拉起"。
            const uncapped = job.backoff_ms * Math.pow(2, Math.min(31, c.restarts - 1));
            if (uncapped > delay) {
              appendAlert(alertsPath, 'backoff_capped', { job: job.id, restarts: c.restarts, delay_ms: delay, uncapped_ms: uncapped });
            }
            if (ledger && ledger.append) ledger.append('supervisor', 'task.restart', { job: job.id, restarts: c.restarts, delay_ms: delay });
          } else if (shouldRestart) {
            entry.status = 'failed';
            entry.last_error = '超过 max_restarts（' + job.max_restarts + '）';
            appendAlert(alertsPath, 'max_restarts', { job: job.id, restarts: c.restarts, max_restarts: job.max_restarts });
          }
          state.jobs[job.id] = entry;
        }
        continue;
      }

      if (!c) {
        // T-389：spawn 前端口预检。端口已被占用时不 spawn（否则必然 EADDRINUSE），
        // 记 alert + port_conflict 状态，并按封顶退避下一轮再探。
        if (job.port) {
          const probe = await portProbe(job.port);
          if (probe.listening) {
            const ownerPid = portOwner ? portOwner(job.port) : null;
            entry.status = 'port_conflict';
            entry.exit_code = null;
            entry.pid = null;
            entry.restarts = entry.restarts || 0;
            entry.last_beat_at = new Date().toISOString();
            entry.last_error = '端口 ' + job.port + ' 已被占用' + (ownerPid ? '（pid=' + ownerPid + '）' : '') + '，暂不拉起';
            entry.port = job.port;
            entry.port_owner_pid = ownerPid;
            entry.conflict_seen_at = entry.conflict_seen_at || new Date().toISOString();
            state.jobs[job.id] = entry;
            // 只在首次发现冲突或占用者变化时写 alert，避免每 tick 刷屏。
            const key = job.port + ':' + (ownerPid || '?');
            if (entry.alert_key !== key) {
              entry.alert_key = key;
              appendAlert(alertsPath, 'port_conflict', { job: job.id, port: job.port, owner_pid: ownerPid, reason: probe.reason });
              if (ledger && ledger.append) ledger.append('supervisor', 'task.port_conflict', { job: job.id, port: job.port, owner_pid: ownerPid });
            }
            continue;
          }
          if (entry.status === 'port_conflict') {
            // 端口已释放：清掉冲突标记，恢复正常拉起流程。
            entry.status = 'stopped';
            entry.last_error = null;
            delete entry.alert_key;
            delete entry.port_owner_pid;
            delete entry.conflict_seen_at;
          }
        }
        let child;
        // T-432/T-429: 真实 spawn → 子进程 stdout/stderr 直接落盘 logs/<jobId>.out|err.log（append）。
        // 测试注入 spawnFn → 保持 pipe 内存捕获（行为不变）。
        const useFileStdio = !spawnFn;
        let childOutLog = null, childErrLog = null, outFd = -1, errFd = -1;
        if (useFileStdio) {
          try {
            const logsDir = join(dirname(alertsPath || DEFAULT_ALERTS_PATH), 'logs');
            mkdirSync(logsDir, { recursive: true });
            childOutLog = join(logsDir, job.id + '.out.log');
            childErrLog = join(logsDir, job.id + '.err.log');
            rotateIfLarge(childOutLog);
            rotateIfLarge(childErrLog);
            outFd = openSync(childOutLog, 'a');
            errFd = openSync(childErrLog, 'a');
          } catch { outFd = -1; errFd = -1; childOutLog = null; childErrLog = null; }
        }
        const spawnStdio = (outFd >= 0 && errFd >= 0) ? ['ignore', outFd, errFd] : ['ignore', 'pipe', 'pipe'];
        try {
          child = spawnChild(job.command[0], job.command.slice(1), {
            cwd: job.cwd, env: childEnv(job, env), windowsHide: true, stdio: spawnStdio,
          });
          if (outFd >= 0) { try { closeSync(outFd); } catch { /* already closed */ } }
          if (errFd >= 0) { try { closeSync(errFd); } catch { /* already closed */ } }
        } catch (e) {
          if (outFd >= 0) { try { closeSync(outFd); } catch {} }
          if (errFd >= 0) { try { closeSync(errFd); } catch {} }
          entry.status = 'failed';
          entry.exit_code = -1;
          entry.restarts = entry.restarts || 0;
          entry.last_beat_at = new Date().toISOString();
          entry.last_error = 'spawn 同步抛异常: ' + (e && e.message || e);
          state.jobs[job.id] = entry;
          if (ledger && ledger.append) ledger.append('supervisor', 'task.end', { job: job.id, exit_code: -1, error: entry.last_error, restarts: entry.restarts });
          appendAlert(alertsPath, 'spawn_exception', { job: job.id, error: entry.last_error });
          continue;
        }
        if (!child) {
          entry.status = 'failed';
          entry.exit_code = -1;
          entry.last_error = 'spawn 失败（返回空）';
          entry.last_beat_at = new Date().toISOString();
          state.jobs[job.id] = entry;
          appendAlert(alertsPath, 'spawn_failed', { job: job.id });
          continue;
        }
        const meta = {
          child, startedAt: new Date().toISOString(),
          restarts: entry.restarts || 0,
          nextStartAt: 0, pending: false, recorded: false,
          spawnError: null,
          output: { stdout: '', stderr: '' },
          logFiles: (childOutLog && childErrLog) ? { out: childOutLog, err: childErrLog } : null,
        };
        children.set(job.id, meta);
        const drain = (side, buf) => {
          const s = meta.output[side];
          meta.output[side] = s.length >= CHILD_OUTPUT_CAP ? s : s + buf.toString('utf8').slice(0, CHILD_OUTPUT_CAP - s.length);
        };
        if (child.stdout) child.stdout.on('data', (d) => drain('stdout', d));
        if (child.stderr) child.stderr.on('data', (d) => drain('stderr', d));
        if (typeof child.on === 'function') {
          child.on('error', (err) => {
            meta.spawnError = String((err && err.message) || err);
            meta.child.exitCode = -2;
          });
          child.on('exit', (code) => {
            if (meta.spawnError) return;
            meta.child.exitCode = (code === null || code === undefined) ? 0 : code;
          });
        }
        entry.status = 'running';
        entry.pid = child.pid || null;
        entry.started_at = meta.startedAt;
        entry.last_beat_at = new Date().toISOString();
        entry.last_error = null;
        entry.exit_code = null;
        // 守护（重）启后从持久态恢复的条目带旧 conflict_seen_at（上一次冲突首次发现时间，久未清理）——spawn 成功后即清，避免快照把陈旧字段沉淀下去
        delete entry.conflict_seen_at;
        state.jobs[job.id] = entry;
        if (ledger && ledger.append) ledger.append('supervisor', 'task.start', { job: job.id, pid: child.pid || null, command: job.command[0] });
      } else {
        entry.last_beat_at = new Date().toISOString();
        state.jobs[job.id] = entry;
      }
    }
    for (const id of Array.from(children.keys())) {
      if (!readJobs(jobsPath).some((j) => j.id === id)) {
        try { children.get(id).child.kill(); } catch { /* 忽略 */ }
        children.delete(id);
        delete state.jobs[id];
      }
    }
    const snap = snapshot();
    try { writeState(snap, statePath); } catch { /* 忽略 */ }
    if (ledger && ledger.append && ticks === 1) ledger.append('supervisor', 'run.start', { jobs: jobs.length, tick_ms: tickMs });
    if (ticks >= maxTicks) break;
    await new Promise((r) => setTimeout(r, tickMs));
  }

  const finalState = snapshot();
  try { writeState(finalState, statePath); } catch { /* 忽略 */ }
  if (ledger && ledger.append) ledger.append('supervisor', 'run.end', { ticks });
  for (const c of children.values()) { try { c.child.kill(); } catch { /* 忽略 */ } }
  return { ticks, state: finalState };
}

export const DEFAULT_LOCK_PATH = join(DEFAULT_SUPERVISOR_DIR, 'daemon.lock');

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

// stale lock reclaim: confirm the pid's identity before trusting it as a live daemon.
// 2026-11-16 incident: stale lock pid=4176 (heartbeat stale 30s+) was REUSED by chrome.exe after reboot;
// pidAlive() said "alive" -> daemon refused to start -> 1888 stayed dead while schtasks reported result=0.
// Only a live *node* pid is treated as a live daemon; tasklist/ps parse failure => not node => reclaimable.
export function isNodeProcess(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
      if (r.status !== 0) return false;
      const m = /^"([^"]+)"/m.exec(String(r.stdout || ''));
      if (!m) return false; // "INFO: No tasks are running ..."
      return /^node(\.exe)?$/i.test(m[1].trim());
    }
    const r = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    if (r.status !== 0) return false;
    return /\bnode/i.test(String(r.stdout || '').trim());
  } catch { return false; }
}

export function readLock(lockPath = DEFAULT_LOCK_PATH) {
  if (!existsSync(lockPath)) return null;
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

export function acquireDaemonLock({ lockPath = DEFAULT_LOCK_PATH, pid = process.pid, now = null, isNodePid = isNodeProcess } = {}) {
  const t = typeofNow(now);
  const cur = readLock(lockPath);
  if (cur && cur.pid && cur.pid !== pid) {
    const fresh = cur.heartbeat_at && (t - Date.parse(cur.heartbeat_at) < STALE_LOCK_MS);
    const aliveNode = pidAlive(cur.pid) && isNodePid(cur.pid);
    // fresh (heartbeat within 30s) is sufficient evidence of a live lock; a stale lock whose pid is
    // still alive only blocks us when that pid is still a node process (i.e. the old daemon itself).
    // Otherwise the pid was reused by an unrelated process and the stale lock is reclaimable.
    if (fresh || aliveNode) {
      return { ok: false, pid: cur.pid, started_at: cur.started_at || null, reason: '已有守护进程在跑' };
    }
  }
  ensureDir(lockPath.replace(/[\\/][^\\/]+$/, ''));
  const nowIso = new Date(t).toISOString();
  writeJsonAtomic(lockPath, { version: 'v1', pid, started_at: nowIso, heartbeat_at: nowIso, token: randomUUID() });
  return { ok: true, pid };
}

export function heartbeatDaemonLock({ lockPath = DEFAULT_LOCK_PATH, pid = process.pid, now = null } = {}) {
  const cur = readLock(lockPath);
  if (!cur || cur.pid !== pid) return false;
  try {
    cur.heartbeat_at = new Date(typeofNow(now)).toISOString();
    writeJsonAtomic(lockPath, cur);
    return true;
  } catch { return false; }
}

export function releaseDaemonLock({ lockPath = DEFAULT_LOCK_PATH, pid = process.pid } = {}) {
  const cur = readLock(lockPath);
  if (cur && cur.pid && cur.pid !== pid) return false;
  try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
}

export function taskExists(taskName = DEFAULT_TASK_NAME) {
  const r = spawnSync('schtasks.exe', ['/Query', '/TN', taskName], { encoding: 'utf8' });
  return r.status === 0;
}

export function buildInstallArgs({
  taskName = DEFAULT_TASK_NAME,
  repoRoot = REPO_ROOT,
  userName = 'SYSTEM',
  intervalHours = 1,
} = {}) {
  const vbs = join(repoRoot, 'bin', 'titan-supervisor-launch.vbs');
  const tr = 'wscript.exe "' + vbs + '"';
  return [
    '/Create', '/TN', taskName, '/TR', tr,
    '/SC', 'HOURLY', '/MO', String(intervalHours),
    '/RU', userName,
    '/F',
  ];
}

export function installScheduledTask({
  taskName = DEFAULT_TASK_NAME, runNow = true, userName = 'SYSTEM', intervalHours = 1,
  repoRoot = REPO_ROOT,
} = {}) {
  if (taskExists(taskName)) return { ok: false, status: 'exists', taskName };
  const args = buildInstallArgs({ taskName, repoRoot, userName, intervalHours });
  const create = spawnSync('schtasks.exe', args, { encoding: 'utf8' });
  if (create.status !== 0) {
    return { ok: false, status: 'create_failed', taskName, detail: String(create.stderr || create.stdout || '').trim().slice(0, 300) };
  }
  let run = null;
  if (runNow) run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8' });
  return { ok: true, status: 'created', taskName, started: !!(run && run.status === 0), detail: run ? String(run.stderr || run.stdout || '').trim().slice(0, 200) : '' };
}

export function uninstallScheduledTask(taskName = DEFAULT_TASK_NAME) {
  if (!taskExists(taskName)) return { ok: true, status: 'absent', taskName };
  spawnSync('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8' });
  const del = spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8' });
  if (taskExists(taskName)) {
    spawnSync('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8' });
    spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8' });
  }
  const stillThere = taskExists(taskName);
  return {
    ok: !stillThere,
    status: stillThere ? 'delete_failed' : 'deleted',
    taskName,
    detail: String(del.stderr || del.stdout || '').trim().slice(0, 200),
  };
}

export function summarizeState(state) {
  const rows = [];
  for (const id of Object.keys(state.jobs || {})) {
    const j = state.jobs[id];
    rows.push([id, j.status, j.pid || '-', j.restarts || 0, j.exit_code === null || j.exit_code === undefined ? '-' : j.exit_code, j.last_beat_at || '-'].join(' | '));
    if (j.status === 'port_conflict' && j.last_error) rows.push('    └ ' + j.last_error);
  }
  return rows.join('\n');
}

export default {
  DEFAULT_SUPERVISOR_DIR, DEFAULT_JOBS_PATH, DEFAULT_STATE_PATH, DEFAULT_ALERTS_PATH, DEFAULT_TASK_NAME,
  RESTART_POLICIES, JOB_STATUSES, ENV_ALLOWLIST, STALE_LOCK_MS, CHILD_OUTPUT_CAP,
  DEFAULT_MAX_BACKOFF_MS, PORT_PROBE_TIMEOUT_MS, computeBackoffMs, probePort, findPortOwnerPid,
  normalizeJob, readJobs, writeJobs, upsertJob, removeJob, readState, writeState, childEnv,
  runDaemon, taskExists, buildInstallArgs, installScheduledTask, uninstallScheduledTask, summarizeState,
  DEFAULT_LOCK_PATH, acquireDaemonLock, releaseDaemonLock, heartbeatDaemonLock, readLock, pidAlive, isNodeProcess,
};