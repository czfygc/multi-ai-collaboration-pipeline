// lib/history-locks.mjs — T-61 P3 提取（机械搬移自 orchestrate.mjs；块体逐字节未动，仅加 export 前缀）
// 符号集（计划 C-3）：registerDailyDispatch（内嵌 acquireLock/releaseLock 异步版随宿主整体搬移——审计 H2 类）、
// generateDispatchId、appendDispatchHistory（内嵌同步版 acquire/releaseLock）、historyHasSha。
// dispatchLocks/lockDispatchId/unlockDispatchId（submitVerdict 的 dispatchId 互斥对）按计划 C-5 归 P5，本阶段留入口。
// 依赖（块内自由标识符扫描实证）：node:fs 九函数、join/dirname、randomBytes、
// constants（TITAN_ROOT/DISPATCH_HISTORY_LOG/FILE_LOCK_*/__dirname——__dirname 语义=orchestrator/，与原入口一致）。
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, renameSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { TITAN_ROOT, DISPATCH_HISTORY_LOG, FILE_LOCK_POLL_MS, FILE_LOCK_TIMEOUT_MS, FILE_LOCK_STALE_MS, __dirname } from './constants.mjs';

// ⑦ 每日上限记账（Director 复核指令1）：分发处挂接 orchestrator/limits.json，
// 计数落 reviews/_autopilot/counters/<date>.json（唯一写者=autopilot/分发进程）。
// 超限返回 {ok:false}，调用方必须停批（exit 2）。记账异常按 fail-closed 处理。
export async function registerDailyDispatch(channel) {
  async function acquireLock(lockPath, timeout) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        const fd = openSync(lockPath, 'wx');
        closeSync(fd);
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
        // DELTA-023（T-59 批2c）：崩溃残留锁回收——进程死亡不会走 finally，锁龄超阈值
        // 视为陈旧残留，删除后立即重试（阈值 5s >> 正常持有时长（毫秒级原子写））。
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            console.warn('[WARN] 回收陈旧计数器锁文件: ' + lockPath);
            continue;
          }
        } catch { /* DELTA-022：锁在 EEXIST→stat 间隙被释放属良性竞态——下轮循环直接获取，静默正确 */ }
        await new Promise((resolve) => setTimeout(resolve, FILE_LOCK_POLL_MS));
      }
    }
    return false;
  }
  function releaseLock(lockPath) {
    // DELTA-022：ENOENT=锁已不在（良性）；其余释放失败必须可见，防静默死锁
    try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') console.warn('[WARN] 计数器锁释放失败: ' + e.message); }
  }
  try {
    const limitsPath = join(__dirname, 'limits.json');
    if (!existsSync(limitsPath)) return { ok: false, reason: 'limits.json 缺失（配置错误，fail-closed）' };
    const limits = JSON.parse(readFileSync(limitsPath, 'utf8'));
    const cap = limits.daily && limits.daily['dispatch_' + channel];
    if (!Number.isInteger(cap)) return { ok: false, reason: 'limits.json 无 dispatch_' + channel + ' 上限' };
    const day = new Date().toISOString().slice(0, 10);
    const dir = join(TITAN_ROOT, 'reviews', '_autopilot', 'counters');
    const file = join(dir, day + '.json');
    const lockPath = file + '.lock';
    // Ensure directory exists
    mkdirSync(dir, { recursive: true });
    // acquire lock with timeout 500ms
    const lockTimeout = FILE_LOCK_TIMEOUT_MS;
    // P1-02: acquireLock 是 async——缺 await 会把 Promise 当真值，fail-closed 锁直接失效
    if (!(await acquireLock(lockPath, lockTimeout))) {
      return { ok: false, reason: '无法获取计数器文件锁，超时' };
    }
     try {
       let c = { date: day, cdp: 0, api: 0, writer: 'autopilot' };
       if (existsSync(file)) {
         const fileContent = readFileSync(file, 'utf8');
         c = JSON.parse(fileContent);
       }
       const used = Number(c[channel] || 0);
       if (used >= cap) {
         return { ok: false, reason: day + ' ' + channel + ' 已用 ' + used + '/' + cap + '，超限', channel, used, cap };
       }
        c[channel] = used + 1;
       const tempPath = file + '.tmp';
       writeFileSync(tempPath, JSON.stringify(c, null, 2), 'utf8');
       renameSync(tempPath, file);
       return { ok: true, channel, used: c[channel], cap, day };
     } finally {
       releaseLock(lockPath);
     }
  } catch (e) {
    return { ok: false, reason: '记账异常(fail-closed): ' + e.message };
  }
}

// ---------- dispatch-history ----------
// P2: dispatchId 碰撞保护 —— reviews/<id> 已存在即重抽，避免覆盖历史分发目录。
// 4 字节 hex 只有 2^32 空间，目录数增长后碰撞非零概率；连运钩子靠 dispatchId 驱动，覆盖会污染链路。
export function generateDispatchId() {
  for (let i = 0; i < 64; i++) {
    const id = randomBytes(4).toString('hex');
    if (!existsSync(join(TITAN_ROOT, 'reviews', id))) return id;
  }
  throw new Error('dispatchId 碰撞 64 次仍未解决，终止以免覆盖历史目录');
}

// P2-10: dispatch-history 记录 parentDispatchId，便于追踪连运链
export function appendDispatchHistory(sha, dispatchId, timestamp, round, trig, mode = 'review', parent = null) {
   // P1-06: DISPATCH_FAILED/DISPATCH_ABORTED 不以 sha 开头；historyHasSha 不拦截重跑
   // P2-18: 增加 mode 字段以便追溯
   // P2-12: 原子写 + 文件锁（使用文件锁确保跨进程安全）
   const fields = [sha, dispatchId, timestamp, round, trig, mode];
   if (parent) fields.push('P=' + parent);
   const line = fields.join(' ');
   mkdirSync(dirname(DISPATCH_HISTORY_LOG), { recursive: true });

   // 文件锁实现
   function acquireLock(lockPath, timeout) {
     const start = Date.now();
     while (Date.now() - start < timeout) {
       try {
         const fd = openSync(lockPath, 'wx');
         closeSync(fd);
         return true;
       } catch (err) {
         if (err.code !== 'EEXIST') throw err;
        // DELTA-023（T-59 批2c）：崩溃残留锁回收（同步版，与计数器锁同一策略）
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > FILE_LOCK_STALE_MS) {
            unlinkSync(lockPath);
            console.warn('[WARN] 回收陈旧 dispatch-history 锁文件');
            continue;
          }
        } catch { /* DELTA-022：良性竞态同计数器锁——下轮循环直接获取 */ }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, FILE_LOCK_POLL_MS);
       }
     }
     return false;
   }

   function releaseLock(lockPath) {
     // DELTA-022：ENOENT=良性；其余释放失败必须可见
     try { unlinkSync(lockPath); } catch (e) { if (e.code !== 'ENOENT') console.warn('[WARN] dispatch-history 锁释放失败: ' + e.message); }
   }

   const lockPath = DISPATCH_HISTORY_LOG + '.lock';
   const lockTimeout = FILE_LOCK_TIMEOUT_MS; // 500ms timeout

   if (!acquireLock(lockPath, lockTimeout)) {
     throw new Error('无法获取dispatch-history文件锁，超时');
   }

   try {
     // 使用带时间戳和进程ID的唯一临时文件，避免并发冲突
     const uniqueTempLog = DISPATCH_HISTORY_LOG + '.tmp.' + Date.now() + '.' + Math.random().toString(36).substr(2, 9);
     const current = existsSync(DISPATCH_HISTORY_LOG) ? readFileSync(DISPATCH_HISTORY_LOG, 'utf8') : '';
     writeFileSync(uniqueTempLog, current + line + '\n', 'utf8');
     renameSync(uniqueTempLog, DISPATCH_HISTORY_LOG);
   } finally {
     releaseLock(lockPath);
   }

   return line;
}

export function historyHasSha(sha) {
  if (!existsSync(DISPATCH_HISTORY_LOG)) return false;
  const txt = readFileSync(DISPATCH_HISTORY_LOG, 'utf8');
  return txt.split('\n').some(l => l.trim().startsWith(sha + ' '));
}
