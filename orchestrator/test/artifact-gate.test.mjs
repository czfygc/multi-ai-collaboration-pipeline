// T-175: 产物级闸门四件套回归 —— manifest / license-notice / anon-download / stage-gate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildManifest, writeManifest, readManifest, verifyManifest, manifestFingerprint, listFiles,
} from '../lib/artifact-manifest.mjs';
import { checkLicenses, parseNotice, ARTIFACT_PROFILES } from '../lib/license-notice-check.mjs';
import { verifyAnonDownload, makeResilientFetch } from '../lib/anon-download-verify.mjs';
import { evaluateStages, runStageGate } from '../lib/stage-gate.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../artifact-gate.mjs', import.meta.url));

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 't175-gate-'));
}

function makeArtifact(dir, { deps = {}, notice = null, license = 'MIT' } = {}) {
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: deps }, null, 2));
  writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 1;\n');
  if (license) writeFileSync(join(dir, 'LICENSE'), license + '\n');
  if (notice) writeFileSync(join(dir, 'NOTICE'), notice);
  return dir;
}

// ── ① 产物清单 ──────────────────────────────────────────────────────────────
test('产物清单：文件 + 大小 + SHA256，路径按字典序；同内容两次生成指纹一致', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir);
    writeFileSync(join(dir, 'README.md'), '# demo\n');
    const m = buildManifest({ root: dir, profile: 'node-cli' });
    assert.equal(m.file_count, 4);
    assert.deepEqual(m.files.map((f) => f.path), ['LICENSE', 'README.md', 'package.json', 'src/index.js']);
    const pkg = m.files.find((f) => f.path === 'package.json');
    assert.equal(pkg.bytes, readFileSync(join(dir, 'package.json')).length);
    assert.match(pkg.sha256, /^[0-9a-f]{64}$/);
    const m2 = buildManifest({ root: dir, profile: 'node-cli', generatedAt: 'fixed' });
    assert.equal(manifestFingerprint(m), manifestFingerprint(m2));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('产物清单：默认排除 node_modules / .git', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir);
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'index.js'), 'x');
    mkdirSync(join(dir, '.git'), { recursive: true });
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref');
    const files = listFiles(dir);
    assert.ok(!files.some((f) => f.includes('node_modules')));
    assert.ok(!files.some((f) => f.includes('.git')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('产物清单校验：改动 / 多文件 / 少文件 三种都判 FAIL 且问题类型正确', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir);
    const m = buildManifest({ root: dir });
    assert.equal(verifyManifest({ root: dir, manifest: m }).status, 'PASS');

    writeFileSync(join(dir, 'src', 'index.js'), 'export const x = 2;\n');   // 改了内容
    writeFileSync(join(dir, 'extra.txt'), 'x');                            // 多一个
    const res = verifyManifest({ root: dir, manifest: m });
    assert.equal(res.status, 'FAIL');
    const types = res.issues.map((i) => i.type);
    assert.ok(types.includes('mismatched'));
    assert.ok(types.includes('extra'));

    rmSync(join(dir, 'src', 'index.js'));                                  // 少一个
    const res2 = verifyManifest({ root: dir, manifest: m });
    assert.ok(res2.issues.map((i) => i.type).includes('missing'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── ② 许可证 / NOTICE 核对 ─────────────────────────────────────────────────
test('NOTICE 解析：识别 "<pkg>@<version> <LICENSE>"，无法解析的行单独列出', () => {
  const p = parseNotice('# comment\nfoo@1.2.3 MIT\nbar@0.1.0 Apache-2.0\n这不是一行\n');
  assert.equal(p.entries.size, 2);
  assert.equal(p.entries.get('foo').license, 'MIT');
  assert.equal(p.entries.get('bar').version, '0.1.0');
  assert.equal(p.unparsed.length, 1);
});

test('许可证核对：无依赖 + 有 LICENSE → PASS', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir, { deps: {} });
    const res = checkLicenses({ root: dir, profileName: 'node-cli' });
    assert.equal(res.status, 'PASS');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('许可证核对：有依赖但没 NOTICE → FAIL（未署名）', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir, { deps: { leftpad: '1.3.0' } });
    const res = checkLicenses({ root: dir, profileName: 'node-cli' });
    assert.equal(res.status, 'FAIL');
    assert.ok(res.issues.some((i) => i.type === 'missing_notice' || i.type === 'unattributed_deps'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('许可证核对：依赖都在 NOTICE 里署名 → PASS', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir, { deps: { leftpad: '1.3.0', chalk: '5.0.0' }, notice: 'leftpad@1.3.0 MIT\nchalk@5.0.0 MIT\n' });
    const res = checkLicenses({ root: dir, profileName: 'node-cli' });
    assert.equal(res.status, 'PASS');
    assert.equal(res.checked.length, 2);
    assert.equal(res.deps_count, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('许可证核对：禁用许可证（AGPL）→ FAIL；没写标识 → UNKNOWN', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir, { deps: { evil: '1.0.0' }, notice: 'evil@1.0.0 AGPL-3.0\n' });
    const res = checkLicenses({ root: dir, profileName: 'node-cli' });
    assert.equal(res.status, 'FAIL');
    assert.ok(res.issues.some((i) => i.type === 'denied_license'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const dir2 = tmpDir();
  try {
    makeArtifact(dir2, { deps: { weird: '1.0.0' }, notice: 'weird@1.0.0\n' });
    const res = checkLicenses({ root: dir2, profileName: 'node-cli' });
    assert.equal(res.status, 'UNKNOWN', '许可证标识判不了 → 显式未知');
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
});

test('许可证核对：python profile 读 requirements.txt；gui/installer 本期未实现 → UNKNOWN', () => {
  const dir = tmpDir();
  try {
    mkdirSync(join(dir, 'pkg'), { recursive: true });
    writeFileSync(join(dir, 'requirements.txt'), 'requests==2.31.0\n# comment\n');
    writeFileSync(join(dir, 'LICENSE'), 'MIT\n');
    writeFileSync(join(dir, 'NOTICE'), 'requests@2.31.0 Apache-2.0\n');
    const res = checkLicenses({ root: dir, profileName: 'python-package' });
    assert.equal(res.status, 'PASS');
    assert.equal(res.deps_count, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const gui = checkLicenses({ root: tmpDir(), profileName: 'gui' });
  assert.equal(gui.status, 'UNKNOWN');
  assert.equal(ARTIFACT_PROFILES.gui.implemented, false);
  assert.equal(ARTIFACT_PROFILES.installer.implemented, false);
});

// ── ③ 匿名可下载 ───────────────────────────────────────────────────────────
function fakeFetch(behaviour) {
  return async (url, init) => {
    const b = behaviour(String(url), init.method) || {};
    if (b.throw) { const e = new Error('net down'); e.name = 'Error'; throw e; }
    const body = b.body || 'hello';
    return {
      status: b.status || 200,
      arrayBuffer: async () => Buffer.from(body),
    };
  };
}

test('匿名可下载：页面 200 + 下载体哈希/字节一致 → PASS', async () => {
  const body = 'hello';
  const sha = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  const fetchImpl = fakeFetch((url, method) => {
    if (method === 'HEAD') return { status: 302 };
    if (url.includes('private')) return { status: 404 };
    return { status: 200, body };
  });
  const res = await verifyAnonDownload({
    page: 'https://example.invalid/repo', release: 'https://example.invalid/release',
    download: 'https://example.invalid/file.bin', privateRepo: 'https://example.invalid/private',
    expected: { sha256: sha, bytes: body.length }, fetchImpl,
  });
  assert.equal(res.status, 'PASS');
  assert.equal(res.checks.length, 5);
});

test('匿名可下载：哈希不符 → FAIL；网络异常 → UNKNOWN；没给期望值 → UNKNOWN', async () => {
  const bad = await verifyAnonDownload({
    download: 'https://example.invalid/f', expected: { sha256: 'deadbeef'.repeat(8), bytes: 5 },
    fetchImpl: fakeFetch(() => ({ status: 200, body: 'hello' })),
  });
  assert.equal(bad.status, 'FAIL');

  const netDown = await verifyAnonDownload({
    download: 'https://example.invalid/f', expected: { sha256: 'x'.repeat(64), bytes: 5 },
    fetchImpl: fakeFetch(() => ({ throw: true })),
  });
  assert.equal(netDown.status, 'UNKNOWN');

  const noExpected = await verifyAnonDownload({
    download: 'https://example.invalid/f', expected: {},
    fetchImpl: fakeFetch(() => ({ status: 200, body: 'hello' })),
  });
  assert.equal(noExpected.status, 'UNKNOWN');
});

test('匿名可下载：网络层失败时自动回落到 curl（代理环境必需）', async () => {
  // 内置 fetch 抛网络错误 → 组合器必须回落到 fallback（curl 适配器），而不是把 UNKNOWN 当结论
  const primary = async () => { throw new Error('fetch failed'); };
  const fallback = async (url, init = {}) => ({
    status: 200,
    arrayBuffer: async () => Buffer.from('hello'),
    text: async () => 'hello',
  });
  const resilient = makeResilientFetch({ fetchImpl: primary, fallbackImpl: fallback });
  const res = await resilient('https://example.invalid/f', { method: 'GET' });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), 'hello');
  // 回落成功时，闸门整体应判 PASS（而不是 UNKNOWN）
  const gate = await verifyAnonDownload({
    download: 'https://example.invalid/f',
    expected: { sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824', bytes: 5 },
    fetchImpl: resilient,
  });
  assert.equal(gate.status, 'PASS');
});

test('匿名可下载：私有源码仓返回 200 → FAIL', async () => {
  const res = await verifyAnonDownload({
    privateRepo: 'https://example.invalid/private',
    fetchImpl: fakeFetch(() => ({ status: 200, body: 'leak' })),
  });
  assert.equal(res.status, 'FAIL');
  assert.ok(res.checks.some((c) => c.name === 'private_source' && c.status === 'FAIL'));
});

// ── ④ 三段阶段闸 ───────────────────────────────────────────────────────────
test('阶段闸：三段全 PASS → PASS；任一段 FAIL → FAIL', () => {
  assert.equal(evaluateStages({ code: 'PASS', artifact: 'PASS', release: 'PASS' }).status, 'PASS');
  const f = evaluateStages({ code: 'PASS', artifact: 'PASS', release: 'FAIL' });
  assert.equal(f.status, 'FAIL');
});

test('阶段闸：后段 PASS 而前段 FAIL → FAIL（代码没过不能说产物对了）', () => {
  const r = evaluateStages({ code: 'FAIL', artifact: 'PASS', release: 'PASS' });
  assert.equal(r.status, 'FAIL');
  assert.ok(r.issues.some((i) => i.type === 'stage_order'));
  const r2 = evaluateStages({ code: 'PASS', artifact: 'FAIL', release: 'PASS' });
  assert.equal(r2.status, 'FAIL');
  assert.ok(r2.issues.some((i) => /发布段 PASS 但产物段/.test(i.detail)));
});

test('阶段闸：前段未判 + 后段 PASS → 总体 UNKNOWN（不是矛盾），但也不能算通过', () => {
  const r = evaluateStages({ code: null, artifact: 'PASS', release: null });
  assert.equal(r.status, 'UNKNOWN');
  assert.ok(r.warnings.some((w) => w.type === 'stage_unbacked'));
  assert.equal(r.issues.length, 0, '未判不算矛盾，只算缺背书');
});

test('阶段闸：未判 / UNKNOWN → 总体 UNKNOWN（显式未知，不当通过）', () => {
  assert.equal(evaluateStages({ code: 'PASS' }).status, 'UNKNOWN');
  assert.equal(evaluateStages({ code: 'PASS', artifact: 'UNKNOWN' }).status, 'UNKNOWN');
  assert.equal(evaluateStages({}).status, 'UNKNOWN');
});

test('总判：runStageGate 汇总 manifest/license/anon；清单 FAIL 传导为总体 FAIL', () => {
  const res = runStageGate({
    code: 'PASS',
    manifest: { status: 'PASS', issues: [] },
    license: { status: 'PASS', issues: [] },
    anonDownload: { status: 'UNKNOWN', checks: [{ name: 'download_bytes', status: 'UNKNOWN', detail: '没给期望哈希' }] },
  });
  assert.equal(res.status, 'UNKNOWN');
  assert.ok(res.issues.some((i) => i.stage === 'release'));

  const bad = runStageGate({
    code: 'PASS',
    manifest: { status: 'FAIL', issues: [{ type: 'mismatched', path: 'a.js', detail: 'SHA256 不一致' }] },
    license: { status: 'PASS', issues: [] },
  });
  assert.equal(bad.status, 'FAIL');
  assert.ok(bad.issues.some((i) => i.detail.includes('SHA256 不一致')));
});

// ── CLI ────────────────────────────────────────────────────────────────────
test('CLI：manifest → verify-manifest 往返；改动后退出码 1；stage-gate 未判退 3', () => {
  const dir = tmpDir();
  try {
    makeArtifact(dir, { deps: {} });
    const manPath = join(dir, 'manifest.json');
    const gen = spawnSync(process.execPath, [CLI, 'manifest', '--root', dir, '--out', manPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(gen.status, 0, gen.stderr);
    assert.ok(existsSync(manPath));

    const ok = spawnSync(process.execPath, [CLI, 'verify-manifest', '--root', dir, '--manifest', manPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stdout + ok.stderr);

    // 代码段未判（没给 --code）+ 发布段未判 → 总体 UNKNOWN（退 3），不是通过
    const gate = spawnSync(process.execPath, [CLI, 'stage-gate', '--root', dir, '--manifest', manPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(gate.status, 3, '未判 = UNKNOWN（退 3），不是通过');
    assert.ok(/UNKNOWN/.test(gate.stdout));

    writeFileSync(join(dir, 'src', 'index.js'), 'changed\n');
    const bad = spawnSync(process.execPath, [CLI, 'verify-manifest', '--root', dir, '--manifest', manPath], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(bad.status, 1);

    // 产物段 FAIL 传导到总体 FAIL
    const gate2 = spawnSync(process.execPath, [CLI, 'stage-gate', '--root', dir, '--manifest', manPath, '--code', 'PASS'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(gate2.status, 1);

    const lic = spawnSync(process.execPath, [CLI, 'license', '--root', dir], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.ok(lic.status === 0 || lic.status === 3, 'license 退出码 ' + lic.status);

    const usage = spawnSync(process.execPath, [CLI, 'manifest'], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
