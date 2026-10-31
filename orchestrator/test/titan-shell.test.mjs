// T-192 titan-shell 回归：head/chain/eval/b64write/verify 五子命令
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const TS = join(dirname(fileURLToPath(import.meta.url)), '..', 'shell', 'titan-shell.mjs');
const dir = mkdtempSync(join(tmpdir(), 'tshell-test-'));
const p = (f) => join(dir, f);
writeFileSync(p('lines.txt'), ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n') + '\n', 'utf8');
writeFileSync(p('ok.mjs'), 'console.log("EVAL_OK");\n', 'utf8');
writeFileSync(p('bad.mjs'), 'syntax ((( here\n', 'utf8');
mkdirSync(p('out'), { recursive: true });

function ts(argv) {
  return spawnSync(process.execPath, [TS, ...argv], { encoding: 'utf8', cwd: dir });
}

describe('titan-shell head', () => {
  test('默认 10 行与 -n 2', () => {
    const a = ts(['head', p('lines.txt')]);
    assert.equal(a.status, 0);
    assert.ok(a.stdout.includes('l5'), 'a=' + a.stdout);
    const b = ts(['head', '-n', '2', p('lines.txt')]);
    assert.ok(b.stdout.includes('l2') && !b.stdout.includes('l3'), 'b=' + b.stdout);
  });
});

describe('titan-shell chain', () => {
  test('全部成功', () => {
    const r = ts(['chain', '--cmd', 'node --version', '--cmd', 'node -e "process.stdout.write(\'1\')"']);
    assert.equal(r.status, 0, 'r=' + r.stdout + r.stderr);
    assert.ok(r.stdout.includes('全部 2 步成功'));
  });
  test('&& 语义：第二步失败即停', () => {
    const r = ts(['chain', '--cmd', 'node --version', '--cmd', 'node -e "process.exit(3)"', '--cmd', 'node --version']);
    assert.equal(r.status, 3);
    assert.ok((r.stdout + r.stderr).includes('不再执行'), 'r=' + r.stdout + r.stderr);
  });
});

describe('titan-shell eval', () => {
  test('脚本走文件通道执行', () => {
    const r = ts(['eval', '--file', p('ok.mjs')]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('EVAL_OK'));
  });
  test('语法坏文件失败透传', () => {
    const r = ts(['eval', '--file', p('bad.mjs')]);
    assert.equal(r.status, 1);
  });
  test('拒绝内联（--file 缺失退 2）', () => {
    const r = ts(['eval']);
    assert.equal(r.status, 2);
  });
});

describe('titan-shell b64write', () => {
  test('写入+回读一致', () => {
    const src = p('payload-src.txt');
    writeFileSync(src, '屠龙刀 b64write 载荷 \\d 不转义', 'utf8');
    const target = join(dir, 'out', 'payload.txt');
    const r = ts(['b64write', '--in', src, '--target', target, '--check']);
    assert.equal(r.status, 0, 'r=' + r.stdout + r.stderr);
    assert.equal(readFileSync(target, 'utf8'), '屠龙刀 b64write 载荷 \\d 不转义');
  });
  test('缺参退 2', () => assert.equal(ts(['b64write', '--in', p('lines.txt')]).status, 2));
});

describe('titan-shell verify', () => {
  test('委托 verify-after-write 退出码透传', () => {
    const dirty = p('dirty.txt');
    writeFileSync(dirty, '带 sper 的行\n', 'utf8');
    const r = ts(['verify', dirty]);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('[VAW]') || r.stdout.includes('ALARM'), 'r=' + r.stdout);
    const clean = p('clean.txt');
    writeFileSync(clean, '正常\n', 'utf8');
    assert.equal(ts(['verify', clean]).status, 0);
  });
});

describe('titan-shell verify-change', () => {
  test('本轮变更：干净文件通过、脏文件拦截', () => {
    // 在临时 git 仓里演（不污染主仓 git status）
    const gdir = mkdtempSync(join(tmpdir(), 'vchange-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: gdir });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: gdir });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: gdir });
      writeFileSync(join(gdir, 'clean.txt'), '正常内容\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: gdir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: gdir });
      // 无变更 → 过
      const r0 = spawnSync(process.execPath, [TS, 'verify-change'], { encoding: 'utf8', cwd: gdir });
      assert.equal(r0.status, 0, 'r0=' + r0.stdout + r0.stderr);
      // 改出一个脏文件（损坏词）→ 拦
      writeFileSync(join(gdir, 'dirty.txt'), '带 sper 的行\n', 'utf8');
      const r1 = spawnSync(process.execPath, [TS, 'verify-change'], { encoding: 'utf8', cwd: gdir });
      assert.equal(r1.status, 1, 'r1=' + r1.stdout + r1.stderr);
      assert.ok((r1.stdout + r1.stderr).includes('denylist:sper'), '应报损坏词');
      // 清理后 → 过
      rmSync(join(gdir, 'dirty.txt'), { force: true });
      const r2 = spawnSync(process.execPath, [TS, 'verify-change'], { encoding: 'utf8', cwd: gdir });
      assert.equal(r2.status, 0, 'r2=' + r2.stdout + r2.stderr);
    } finally {
      try { rmSync(gdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* 句柄延迟留待系统清理 */ }
    }
  });
  test('仅查暂存集：他人未暂存尾随空白不拦本提交（跨端互拦根治）', () => {
    const gdir = mkdtempSync(join(tmpdir(), 'vchange-scope-'));
    try {
      spawnSync('git', ['init', '-q'], { cwd: gdir });
      spawnSync('git', ['config', 'user.email', 't@t'], { cwd: gdir });
      spawnSync('git', ['config', 'user.name', 't'], { cwd: gdir });
      writeFileSync(join(gdir, 'base.txt'), 'ok\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: gdir });
      spawnSync('git', ['commit', '-q', '-m', 'init'], { cwd: gdir });
      // 他人未暂存文件带尾随空白 → git diff --cached --check 查不到，不拦
      writeFileSync(join(gdir, 'other.txt'), 'dirty trailing  \n', 'utf8');
      const r = spawnSync(process.execPath, [TS, 'verify-change'], { encoding: 'utf8', cwd: gdir });
      assert.equal(r.status, 0, 'r=' + r.stdout + r.stderr);
    } finally {
      try { rmSync(gdir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 }); } catch { /* 句柄延迟留待系统清理 */ }
    }
  });
});

describe('titan-shell 用法', () => {
  test('未知子命令退 2', () => assert.equal(ts(['nope']).status, 2));
  test('--help 退 0', () => assert.equal(ts(['--help']).status, 0));
});

test('清理临时目录', () => { rmSync(dir, { recursive: true, force: true }); });
