#!/usr/bin/env node
// titan-shell.mjs — T-192 屠龙刀 shell 辅助一条命令（head / chain / eval / b64write / verify）
// 治四类返工坑：PowerShell 无 head/&&、node -e 引号崩、b64 写盘多步、写后手验。
// 用法:
//   node orchestrator/shell/titan-shell.mjs head [-n N] [file]        # 前 N 行（默认 10；无 file 读 stdin）
//   node orchestrator/shell/titan-shell.mjs chain --cmd "<命令>" ...  # && 等价物，遇非零即停
//   node orchestrator/shell/titan-shell.mjs eval --file <s.mjs> [args...] [--check]  # 安全 node -e（脚本走文件）
//   node orchestrator/shell/titan-shell.mjs b64write --in <明文> --target <路径> [--check] [--sha256 <hex>]
//   node orchestrator/shell/titan-shell.mjs verify <path>... [--json] # 委托 verify-after-write.mjs
// b64write 委托 orchestrator/safe-write.mjs（字节通道+回读校验+高风险闸），不重复造轮子。
// 退出码透传子命令语义：0=成功 1=失败 2=用法错。

import { readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ORCH = join(__dirname, '..');
const SAFE_WRITE = join(ORCH, 'safe-write.mjs');
const VAW = join(ORCH, 'verify-after-write.mjs');

function usage() {
  console.log([
    '用法: node orchestrator/shell/titan-shell.mjs <子命令> [参数]',
    '  head     [-n N] [file]            前 N 行（默认 10；无 file 读 stdin）',
    '  chain    --cmd "<命令>" [--cmd …] && 等价物，遇非零即停',
    '  eval     --file <s.mjs> [args…] [--check]   安全 node -e（脚本走文件，不经命令行字符串层）',
    '  b64write --in <明文> --target <路径> [--check] [--sha256 <hex>]  一条命令字节通道写盘',
    '  verify   <path>… [--json]         写后验闸（node --check/JSON/损坏词）',
    '  verify-change                      本轮 git 变更统一验收（diff --check + 逐文件验刃）',
  ].join('\n'));
}

function args(argv) {
  const out = { flags: new Set(), kv: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length && !argv[i + 1].startsWith('--')) out.kv[a.slice(2)] = argv[++i];
    else if (a.startsWith('-') || a.startsWith('--')) out.flags.add(a.replace(/^--?/, ''));
    else out.rest.push(a);
  }
  return out;
}

function head(argv) {
  let n = 10, file = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-n') n = Number(argv[++i]) || 10;
    else file = argv[i];
  }
  let text;
  if (file) text = readFileSync(file, 'utf8');
  else text = readFileSync(0, 'utf8');
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const l of lines.slice(0, n)) console.log(l);
  return 0;
}

function chain(argv) {
  const cmds = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--cmd') cmds.push(argv[++i]);
  }
  if (cmds.length === 0) { usage(); return 2; }
  for (let i = 0; i < cmds.length; i++) {
    console.log('[T-SHELL] [' + (i + 1) + '/' + cmds.length + '] ' + cmds[i]);
    // cmd /s：仅剥最外层引号，内层引号原样到达目标命令；windowsVerbatimArguments 关掉
    // Node 的 argv 再转义（双层转义会把 node -e "process.exit(3)" 变成字符串表达式假成功）。
    const r = process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', cmds[i]], { stdio: 'inherit', windowsVerbatimArguments: true })
      : spawnSync(cmds[i], { shell: true, stdio: 'inherit' });
    if (r.error || r.status !== 0) {
      console.error('[T-SHELL] 第 ' + (i + 1) + ' 步失败（exit=' + (r.status === null ? 'signal/timeout' : r.status) + '），后续 ' + (cmds.length - i - 1) + ' 步不再执行');
      return r.status === null ? 1 : r.status;
    }
  }
  console.log('[T-SHELL] 全部 ' + cmds.length + ' 步成功');
  return 0;
}

function evalCmd(argv) {
  const a = args(argv);
  const check = a.flags.has('check');
  const file = a.kv.file;
  if (!file) { usage(); return 2; }
  if (!file.endsWith('.mjs') && !file.endsWith('.js') && !file.endsWith('.cjs')) {
    console.error('[T-SHELL] eval 只接受 .mjs/.js/.cjs 文件（脚本必须走文件通道，禁止内联）');
    return 2;
  }
  if (check) {
    const r = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    return r.status === null ? 1 : r.status;
  }
  const r = spawnSync(process.execPath, [file, ...a.rest], { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

function b64write(argv) {
  const a = args(argv);
  const src = a.kv['in'];
  const target = a.kv.target;
  if (!src || !target) { usage(); return 2; }
  const buf = readFileSync(src);
  const b64 = buf.toString('base64');
  const tmpDir = mkdtempSync(join(tmpdir(), 'titan-shell-'));
  const b64File = join(tmpDir, 'payload.b64');
  writeFileSync(b64File, b64, 'utf8');
  const pass = ['--target', target, '--b64', b64File];
  if (a.flags.has('check')) pass.push('--check');
  if (a.kv.sha256) pass.push('--expect-sha256', a.kv.sha256);
  let status;
  try {
    const r = spawnSync(process.execPath, [SAFE_WRITE, ...pass], { stdio: 'inherit' });
    status = r.status === null ? 1 : r.status;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
  if (status === 0) console.log('[T-SHELL] b64write OK: ' + target);
  return status;
}

function verify(argv) {
  const r = spawnSync(process.execPath, [VAW, ...argv], { stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}

// verify-change：本轮 git 变更统一验收入口（ChatGPT 方案 2026-10-24 §五）
// 固定检查：① git diff --cached --check（仅暂存集空白/冲突标记；工作树他人脏文件不拦本提交）
//           ② 变更文本文件逐个过 verify-after-write（VAW 仍扫工作区全部变更，防呆不丢）
function verifyChange() {
  const git = (args) => spawnSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const chk = git(['diff', '--cached', '--check']);
  let bad = 0;
  if ((chk.stdout || '').trim()) {
    console.log('[T-SHELL][VERIFY-CHANGE] git diff --cached --check FAIL:');
    console.log(chk.stdout.trim());
    bad++;
  } else if (chk.status === 0) {
    console.log('[T-SHELL][VERIFY-CHANGE] git diff --cached --check: PASS');
  }
  const st = git(['status', '--porcelain']);
  if (st.status !== 0) { console.error('[T-SHELL][VERIFY-CHANGE] git status 失败'); return 1; }
  const files = [];
  for (const line of (st.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    const path = line.slice(3).replace(/^"|"$/g, '');
    if (code.trim() === 'D') continue; // 删除的文件不扫
    if (/^(.M|.A|\?\?|M.|A.|MM)/.test(code)) files.push(path);
  }
  const TEXT_SKIP = /\.(png|jpe?g|gif|ico|zip|gz|7z|exe|dll|pdf|woff2?|ttf|eot|mp3|mp4|sqlite|db|node|wasm|xlsx|docx|pptx)$/i;
  const targets = [];
  for (const f of files) {
    if (TEXT_SKIP.test(f)) continue;
    try { if (!statSync(f).isFile()) continue; } catch { continue; } // 目录/子模块不扫
    targets.push(f);
  }
  if (targets.length === 0) {
    console.log('[T-SHELL][VERIFY-CHANGE] 无文本变更文件（已跳过二进制/删除）');
    return bad > 0 ? 1 : 0;
  }
  const r = spawnSync(process.execPath, [VAW, ...targets], { stdio: 'inherit' });
  if (r.status !== 0) bad++;
  if (bad === 0) console.log('[T-SHELL][VERIFY-CHANGE] 本轮 ' + targets.length + ' 个变更文件全部通过');
  else console.log('[T-SHELL][VERIFY-CHANGE] 存在 ' + bad + ' 类失败——先修复再进入下一步（提交/测试）');
  return bad > 0 ? 1 : 0;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  let code;
  if (!cmd || cmd === '--help' || cmd === '-h') { usage(); code = cmd ? 0 : 2; }
  else if (cmd === 'head') code = head(rest);
  else if (cmd === 'chain') code = chain(rest);
  else if (cmd === 'eval') code = evalCmd(rest);
  else if (cmd === 'b64write') code = b64write(rest);
  else if (cmd === 'verify') code = verify(rest);
  else if (cmd === 'verify-change') code = verifyChange();
  else { usage(); code = 2; }
  process.exit(code);
}
