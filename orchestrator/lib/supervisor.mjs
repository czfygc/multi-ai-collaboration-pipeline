// orchestrator/lib/supervisor.mjs — T-173 常驻子进程监督器（解"后台进程被会话清理链杀"）
//
// 问题（本仓实证）：本机后台进程（Start-Process / Invoke-CimMethod）**在发起命令结束后被清理链杀掉**
//   → 派出去的长任务"说没就没"。研究轮实测的解法：Windows 计划任务启动的进程**能在会话结束后继续存活**
//   （2026-10-21 实测：schtasks /Run 起的 node 进程，前一个 shell 退出后心跳继续、pid 仍在）。
//
// 本模块职责：
//   1. **守护循环**：按任务清单 spawn 子进程，监控退出，按重启策略拉起（指数退避），写心跳/状态；
//   2. **落状态**：state.json（运行期数据，不入库）+ run-events 事件账本（可回放）；
//   3. **装常驻**：install/uninstall 用 schtasks 把守护进程挂成计划任务（跨会话存活）。
//
// 红线：
//   1. 零依赖（node: 内置）；只管**自己清单里的**进程，不碰系统其它进程。
//   2. 子进程命令必须**显式登记**才跑（不解析自由文本命令）；env 走**白名单**，密钥不落盘。
//   3. 守护进程**自己不重启自己**（重启交给计划任务），避免双实例抢同一 job。
//   4. 状态写盘失败不阻塞主链（只记事件）。

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const DEFAULT_SUPERVISOR_DIR = join(REPO_ROOT, 'orchestrator', 'run-events', 'supervisor');
export const DEFAULT_JOBS_PATH = join(DEFAULT_SUPERVISOR_DIR, 'jobs.json');
export const DEFAULT_STATE_PATH = join(DEFAULT_SUPERVISOR_DIR, 'state.json');
export const DEFAULT_TASK_NAME = 'TITAN-Supervisor';
export const RESTART_POLICIES = Object.freeze(['always', 'on-failure', 'never']);
export const JOB_STATUSES = Object.freeze(['running', 'exited', 'restarting', 'failed', 'stopped']);

// 允许子进程继承的 env 变量白名单（其余一律不传；密钥类默认不传）
export const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'COMSPEC', 'TEMP', 'TMP', 'SystemRoot', 'windir',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'COMPUTERNAME', 'USERNAME', 'TITAN_WORKSPACE',
]);

function ensureDir(path) {
  mkdirSync(path, { recursive: true });
  return path;
}

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function writeJsonAtomic(path, value) {
  ensureDir(path.replace(/[\\/][^\\/]+$/, ''));
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  renameSync(tmp, path);
  return path;
}

// ── 任务清单 ────────────────────────────────────────────────────────────────
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

// 子进程 env：白名单 + 显式允许的变量（密钥类一律不传）
export function childEnv(job, env = process.env) {
  const out = {};
  for (const k of ENV_ALLOWLIST) if (env[k] !== undefined) out[k] = env[k];
  for (const k of (job.env_allow || [])) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

// ── 守护循环 ────────────────────────────────────────────────────────────────
// spawnFn 可注入（测试用），ledger 可注入（默认 run-events 账本，可为 null 不记事件）
export async function runDaemon({
  jobsPath = DEFAULT_JOBS_PATH, statePath = DEFAULT_STATE_PATH,
  tickMs = 2000, maxTicks = Infinity, spawnFn = null, ledger = null, env = process.env, now = () => Date.now(),
} = {}) {
  const spawnChild = spawnFn || ((cmd, args, opts) => spawn(cmd, args, opts));
  const children = new Map();   // jobId → { child, startedAt, restarts, nextStartAt }
  const state = { version: 'v1', updated_at: null, jobs: {} };
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
      };
    }
    return s;
  };

  while (ticks < maxTicks) {
    ticks += 1;
    const jobs = readJobs(jobsPath);
    for (const job of jobs) {
      if (!job.enabled) continue;
      const entry = state.jobs[job.id] || { status: 'stopped', restarts: 0 };
      let c = children.get(job.id);

      if (c && c.pending) {
        // 待重启：到点才拉起
        if (now() < c.nextStartAt) { state.jobs[job.id] = entry; continue; }
        children.delete(job.id);
        c = null;
      }

      if (c && c.child.exitCode !== null) {
        // 子进程已退出 → 记事件 + 按重启策略决定是否拉起（记录过一次就不再重复处理）
        if (!c.recorded) {
          c.recorded = true;
          const code = c.child.exitCode;
          entry.status = 'exited';
          entry.exit_code = code;
          entry.last_beat_at = new Date().toISOString();
          if (ledger && ledger.append) {
            ledger.append('supervisor', 'task.end', { job: job.id, exit_code: code, restarts: c.restarts });
          }
          const shouldRestart = job.restart === 'always' || (job.restart === 'on-failure' && code !== 0);
          if (shouldRestart && c.restarts < job.max_restarts) {
            c.restarts += 1;
            entry.status = 'restarting';
            entry.restarts = c.restarts;
            const delay = job.backoff_ms * Math.pow(2, c.restarts - 1);
            c.pending = true;
            c.nextStartAt = now() + delay;
            entry.next_start_at = new Date(c.nextStartAt).toISOString();
          } else if (shouldRestart) {
            entry.status = 'failed';
            entry.last_error = '超过 max_restarts（' + job.max_restarts + '）';
          }
          state.jobs[job.id] = entry;
        }
        continue;
      }

      if (!c) {
        const child = spawnChild(job.command[0], job.command.slice(1), {
          cwd: job.cwd, env: childEnv(job, env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        if (!child) {
          entry.status = 'failed';
          entry.last_error = 'spawn 失败';
          state.jobs[job.id] = entry;
          continue;
        }
        const meta = { child, startedAt: new Date().toISOString(), restarts: c && c.restarts ? c.restarts : 0, nextStartAt: 0, pending: false, recorded: false };
        children.set(job.id, meta);
        entry.status = 'running';
        entry.pid = child.pid || null;
        entry.started_at = meta.startedAt;
        entry.last_beat_at = new Date().toISOString();
        entry.last_error = null;
        state.jobs[job.id] = entry;
        if (ledger && ledger.append) {
          ledger.append('supervisor', 'task.start', { job: job.id, pid: child.pid || null, command: job.command[0] });
        }
        if (typeof child.on === 'function') {
          child.on('exit', (code) => { meta.child.exitCode = code === null || code === undefined ? 0 : code; });
        }
      } else {
        entry.last_beat_at = new Date().toISOString();
        state.jobs[job.id] = entry;
      }
    }
    // 清理已不在清单里的 job
    for (const id of Array.from(children.keys())) {
      if (!readJobs(jobsPath).some((j) => j.id === id)) {
        try { children.get(id).child.kill(); } catch { /* 忽略 */ }
        children.delete(id);
      }
    }
    const snap = snapshot();
    try { writeState(snap, statePath); } catch { /* 状态写盘失败不阻塞主链 */ }
    if (ledger && ledger.append && ticks === 1) {
      ledger.append('supervisor', 'run.start', { jobs: jobs.length, tick_ms: tickMs });
    }
    if (ticks >= maxTicks) break;
    await new Promise((r) => setTimeout(r, tickMs));
  }

  const finalState = snapshot();
  try { writeState(finalState, statePath); } catch { /* 忽略 */ }
  if (ledger && ledger.append) ledger.append('supervisor', 'run.end', { ticks });
  for (const c of children.values()) { try { c.child.kill(); } catch { /* 忽略 */ } }
  return { ticks, state: finalState };
}

// ── 守护进程单实例锁（防止两个 daemon 抢同一 job）────────────────────────
export const DEFAULT_LOCK_PATH = join(DEFAULT_SUPERVISOR_DIR, 'daemon.lock');

function pidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

export function readLock(lockPath = DEFAULT_LOCK_PATH) {
  if (!existsSync(lockPath)) return null;
  try { return JSON.parse(readFileSync(lockPath, 'utf8')); } catch { return null; }
}

export function acquireDaemonLock({ lockPath = DEFAULT_LOCK_PATH, pid = process.pid, now = Date.now() } = {}) {
  const cur = readLock(lockPath);
  if (cur && cur.pid && cur.pid !== pid && pidAlive(cur.pid)) {
    return { ok: false, pid: cur.pid, started_at: cur.started_at || null, reason: '已有守护进程在跑' };
  }
  ensureDir(lockPath.replace(/[\\/][^\\/]+$/, ''));
  writeJsonAtomic(lockPath, { version: 'v1', pid, started_at: new Date(now).toISOString() });
  return { ok: true, pid };
}

export function releaseDaemonLock({ lockPath = DEFAULT_LOCK_PATH, pid = process.pid } = {}) {
  const cur = readLock(lockPath);
  if (cur && cur.pid && cur.pid !== pid) return false;
  try { rmSync(lockPath, { force: true }); return true; } catch { return false; }
}

// ── Windows 计划任务（跨会话存活）─────────────────────────────────────────
export function taskExists(taskName = DEFAULT_TASK_NAME) {
  const r = spawnSync('schtasks.exe', ['/Query', '/TN', taskName], { encoding: 'utf8' });
  return r.status === 0;
}

// T-186：拼 schtasks /Create 参数（纯函数，可单测）。
// 红线（用户 2026-10-23）：不许把 node.exe 直接交给 schtasks（弹不可关控制台窗）；
// 必须 SYSTEM（重启后不依赖交互登录）+ HOURLY ensure-running（进程死后 1h 内自愈）。
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
  if (runNow) {
    run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8' });
  }
  return { ok: true, status: 'created', taskName, started: !!(run && run.status === 0), detail: run ? String(run.stderr || run.stdout || '').trim().slice(0, 200) : '' };
}

export function uninstallScheduledTask(taskName = DEFAULT_TASK_NAME) {
  if (!taskExists(taskName)) return { ok: true, status: 'absent', taskName };
  // 运行中的任务 /Delete 可能只给警告（退出码 0）→ 先 /End 再 /Delete，最后核验
  spawnSync('schtasks.exe', ['/End', '/TN', taskName], { encoding: 'utf8' });
  const del = spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { encoding: 'utf8' });
  if (taskExists(taskName)) {
    // 再来一次（有时 /End 需要时间生效）
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
  }
  return rows.join('\n');
}

export default {
  DEFAULT_SUPERVISOR_DIR, DEFAULT_JOBS_PATH, DEFAULT_STATE_PATH, DEFAULT_TASK_NAME,
  RESTART_POLICIES, JOB_STATUSES, ENV_ALLOWLIST,
  normalizeJob, readJobs, writeJobs, upsertJob, removeJob, readState, writeState, childEnv,
  runDaemon, taskExists, buildInstallArgs, installScheduledTask, uninstallScheduledTask, summarizeState,
  DEFAULT_LOCK_PATH, acquireDaemonLock, releaseDaemonLock, readLock, pidAlive,
};
