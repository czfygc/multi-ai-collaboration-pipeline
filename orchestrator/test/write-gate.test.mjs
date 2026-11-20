// T-153: 高风险写确认闸回归 —— 目标分类 / 提案不落盘 / 确认才落盘 / TOCTOU / 密钥不落盘
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createGate, classifyTarget, isHighRisk, GATE_CATEGORIES } from '../lib/write-gate.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 't153-gate-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  const gate = createGate({ root: join(root, 'events'), repoRoot: repo });
  return { root, repo, gate };
}

test('目标分类：宪法 / 台账 / 密钥 / 发布树 / 普通', () => {
  const { repo } = sandbox();
  const pub = join(repo, 'publish-tree');
  const cases = [
    [join(repo, 'AGENTS.md'), 'constitution'],
    [join(repo, 'SHARED_GIT_WORKSPACE_GUIDE.md'), 'constitution'],
    [join(repo, 'ISSUE_REGISTRY.json'), 'ledger'],
    [join(repo, 'orchestrator', 'limits.json'), 'ledger'],
    [join(repo, 'titan_secrets.env'), 'secrets'],
    [join(repo, '.env'), 'secrets'],
    [join(repo, '.env.local'), 'secrets'],
    [join(repo, '.env.production'), 'secrets'],
    [join(repo, 'config', 'staging.env'), 'secrets'],
    [join(pub, 'README.md'), 'publish-tree'],
    [join(repo, 'orchestrator', 'run-gate.mjs'), 'normal'],
  ];
  for (const [p, expected] of cases) {
    const cls = classifyTarget(p, { repoRoot: repo, publishTree: pub });
    assert.equal(cls.category, expected, p + ' 分类应为 ' + expected + ' 实际 ' + cls.category);
  }
  assert.deepEqual([...GATE_CATEGORIES], ['constitution', 'ledger', 'publish-tree', 'secrets']);
  assert.equal(isHighRisk('normal'), false);
  assert.equal(isHighRisk('ledger'), true);
});

test('提案不落盘：createProposal 只暂存，目标文件内容不变', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'AGENTS.md');
  writeFileSync(target, 'old body\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', actor: 'tester', reason: 'r', targets: [{ path: target, content: 'new body\n' }] });
  assert.equal(p.status, 'proposed');
  assert.equal(readFileSync(target, 'utf8'), 'old body\n');
  assert.equal(p.targets[0].category, 'constitution');
  assert.equal(p.targets[0].pre_sha256.length, 64);
  assert.ok(p.targets[0].post_sha256);
  assert.ok(existsSync(p.targets[0].stage_file));
});

test('未确认不得落盘：applyProposal 直接抛错', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'ISSUE_REGISTRY.json');
  writeFileSync(target, '{}\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', targets: [{ path: target, content: '{"a":1}\n' }] });
  assert.throws(() => gate.applyProposal(p.id), /未确认/);
  assert.equal(readFileSync(target, 'utf8'), '{}\n');
});

test('确认后落盘：显式确认与署名确认都能写', () => {
  const { repo, gate } = sandbox();
  const t1 = join(repo, 'ISSUE_REGISTRY.json');
  writeFileSync(t1, '{}\n', 'utf8');
  const p1 = gate.createProposal({ kind: 'write', targets: [{ path: t1, content: '{"a":1}\n' }] });
  gate.confirmProposal(p1.id, { by: 'kilo', reason: '验收通过' });
  gate.applyProposal(p1.id);
  assert.equal(readFileSync(t1, 'utf8'), '{"a":1}\n');
  assert.equal(gate.load(p1.id).status, 'applied');

  const t2 = join(repo, 'AGENTS.md');
  writeFileSync(t2, 'x\n', 'utf8');
  const p2 = gate.createProposal({ kind: 'write', confirmed: { by: 'opencode', reason: '本地署名确认' }, targets: [{ path: t2, content: 'y\n' }] });
  assert.equal(p2.status, 'confirmed');
  assert.equal(p2.confirm_mode, 'attested');
  gate.applyProposal(p2.id);
  assert.equal(readFileSync(t2, 'utf8'), 'y\n');
});

test('TOCTOU：提案后目标被改动则拒绝落盘', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'ISSUE_REGISTRY.json');
  writeFileSync(target, '{}\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', confirmed: { by: 'opencode' }, targets: [{ path: target, content: '{"a":1}\n' }] });
  writeFileSync(target, '{"changed":true}\n', 'utf8');
  assert.throws(() => gate.applyProposal(p.id), /被改动/);
  assert.equal(readFileSync(target, 'utf8'), '{"changed":true}\n');
});

test('密钥类目标只记账不落盘', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'titan_secrets.env');
  writeFileSync(target, 'A=1\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', confirmed: { by: 'opencode' }, targets: [{ path: target, content: 'A=2\n' }] });
  assert.throws(() => gate.applyProposal(p.id), /密钥/);
  assert.equal(readFileSync(target, 'utf8'), 'A=1\n');
});

test('提案/确认/落盘都进 run 事件账本', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'ISSUE_REGISTRY.json');
  writeFileSync(target, '{}\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', targets: [{ path: target, content: '{"a":1}\n' }] });
  gate.confirmProposal(p.id, { by: 'kilo' });
  gate.applyProposal(p.id);
  const events = gate.ledger.read(p.run_id);
  const types = events.map(e => e.type);
  assert.ok(types.includes('proposal.created'));
  assert.ok(types.includes('proposal.confirmed'));
  assert.ok(types.includes('proposal.applied'));
});

test('summarize：给出文件清单与增删行数，并标出高风险目标', () => {
  const { repo, gate } = sandbox();
  const target = join(repo, 'AGENTS.md');
  writeFileSync(target, 'a\nb\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', targets: [{ path: target, content: 'a\nb\nc\n' }] });
  const s = gate.summarize(p);
  assert.equal(s.files.length, 1);
  assert.equal(s.files[0].category, 'constitution');
  assert.ok(s.added >= 1);
  assert.deepEqual(s.highRisk, ['AGENTS.md']);
  const diff = gate.renderDiff(p);
  assert.ok(diff.includes('AGENTS.md'));
});

test('普通文件不属高风险类', () => {
  const { repo, gate } = sandbox();
  mkdirSync(join(repo, 'orchestrator'), { recursive: true });
  const target = join(repo, 'orchestrator', 'x.mjs');
  writeFileSync(target, 'a\n', 'utf8');
  const p = gate.createProposal({ kind: 'write', targets: [{ path: target, content: 'b\n' }] });
  assert.equal(p.targets[0].category, 'normal');
  assert.deepEqual(gate.summarize(p).highRisk, []);
});

test('提交型提案：确认后真的 git commit（未确认不提交）', () => {
  const { repo, gate } = sandbox();
  try {
    const git = spawnSync('git', ['init'], { cwd: repo, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    spawnSync('git', ['config', 'user.email', 'gate@test.local'], { cwd: repo });
    spawnSync('git', ['config', 'user.name', 'gate test'], { cwd: repo });
    const target = join(repo, 'newfile.txt');
    writeFileSync(target, 'hello\n', 'utf8');
    const p = gate.createProposal({ kind: 'commit', message: 'feat: gated commit test', targets: [{ path: target }] });
    assert.equal(p.status, 'proposed');
    assert.throws(() => gate.applyProposal(p.id), /未确认/);
    let log = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' });
    assert.equal((log.stdout || '').trim(), '', '未确认时不应有提交');
    gate.confirmProposal(p.id, { by: 'kilo', reason: '验收通过' });
    gate.applyProposal(p.id);
    log = spawnSync('git', ['log', '--oneline'], { cwd: repo, encoding: 'utf8' });
    assert.match(log.stdout, /gated commit test/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
