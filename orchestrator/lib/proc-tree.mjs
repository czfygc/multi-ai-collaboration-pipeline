// orchestrator/lib/proc-tree.mjs — T-124：进程树 kill + 空闲看门狗 + 硬超时
//
// 背景（T-122 e2e run#1 事故形态）：scan-entry 用 spawnSync 调 titan-execute，超时只杀
// 直接子进程——LLM 客户端（opencode/cline 的孙进程）变孤儿继续跑，可在本轮已判失败之后
// 仍改动工作树、甚至提交（"事后偷偷提交"）。执行器自身也缺空闲检测：真挂起要干等满
// 600s 超时；而降档链最坏约 1 小时，远超外层 900s 预算，必被中途砍断并留下半成品改动。
//
// 本模块提供两件事：
//   killTree(pid)             —— 连孙进程一起杀（Windows: taskkill /T /F；POSIX: 杀进程组）
//   runProcess({cmd,args,...}) —— 异步 spawn + 空闲看门狗（idleMs 无输出即杀）+ 硬超时
//
// 语义：hung=true 表示被空闲看门狗杀（真挂起），timedOut=true 表示硬超时杀树。
// 两者都会先杀整棵树，确保不留孤儿事后提交。
import { spawn, spawnSync } from 'node:child_process';

/** 连同子孙进程一起终止（Windows 用 taskkill /T /F；POSIX 优先杀进程组） */
export function killTree(pid) {
  if (!pid) return { ok: false, error: 'no-pid' };
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', timeout: 30000 });
      return { ok: r.status === 0, detail: String(r.stdout || r.stderr || '').trim().slice(0, 200) };
    }
    try { process.kill(-pid, 'SIGKILL'); return { ok: true, detail: 'killed process group' }; }
    catch (e) {
      try { process.kill(pid, 'SIGKILL'); return { ok: true, detail: 'killed pid' }; }
      catch (e2) { return { ok: false, error: String(e2.message) }; }
    }
  } catch (e) {
    return { ok: false, error: String(e.message) };
  }
}

/**
 * 异步跑一个子进程，带空闲看门狗与硬超时。
 * @param {object} o { cmd, args, cwd, env, timeoutMs, idleMs, label, onOutput }
 *   onOutput：可选回调，**首次**收到 stdout/stderr 数据时触发（T-168 执行链检查点用；
 *             不传则行为与从前完全一致）。
 * @returns {Promise<{exitCode:number|null, stdout:string, stderr:string, timedOut:boolean, hung:boolean, durationMs:number, error:?string}>}
 */
export function runProcess(o) {
  const cmd = o.cmd;
  const args = o.args || [];
  const cwd = o.cwd || process.cwd();
  const env = o.env || process.env;
  const timeoutMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : 0;   // 0 = 不设硬超时
  const idleMs = Number(o.idleMs) > 0 ? Number(o.idleMs) : 0;            // 0 = 不设空闲看门狗
  const onOutput = typeof o.onOutput === 'function' ? o.onOutput : null;
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, hung: false, durationMs: Date.now() - started, error: String(e.message) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let lastActivity = Date.now();
    let hung = false;
    let timedOut = false;
    let settled = false;

    const touch = () => { lastActivity = Date.now(); };
    let outputSeen = false;
    const notifyOutput = () => {
      if (outputSeen) return;
      outputSeen = true;
      try { onOutput(); } catch { /* 回调异常不能影响子进程管理 */ }
    };
    if (child.stdout) child.stdout.on('data', (d) => { stdout += d.toString(); touch(); notifyOutput(); });
    if (child.stderr) child.stderr.on('data', (d) => { stderr += d.toString(); touch(); notifyOutput(); });

    let idleTimer = null;
    let hardTimer = null;
    if (idleMs > 0) {
      const step = Math.min(15000, Math.max(500, Math.floor(idleMs / 3)));
      idleTimer = setInterval(() => {
        if (Date.now() - lastActivity >= idleMs) {
          hung = true;
          killTree(child.pid);
        }
      }, step);
    }
    if (timeoutMs > 0) {
      hardTimer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
    }
    const finish = (exitCode, error) => {
      if (settled) return;
      settled = true;
      if (idleTimer) clearInterval(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      resolve({
        exitCode, stdout, stderr, timedOut, hung,
        durationMs: Date.now() - started,
        error: error || null
      });
    };
    child.on('error', (e) => finish(null, String(e.message)));
    child.on('close', (code) => finish(code === null ? null : code, null));
  });
}
