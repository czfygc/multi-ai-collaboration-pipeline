// T-155: 技能质量门回归 —— 校验器规则 + 仓内 19 个技能合规 + CLI 行为
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter, validateSkill, scanSkills, REQUIRED_FIELDS } from '../lib/skill-quality.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const CLI = fileURLToPath(new URL('../skill-quality.mjs', import.meta.url));

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 't155-skills-'));
}

function makeSkill(root, name, frontmatter, body = '# skill\n') {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const text = frontmatter === null ? body : '---\n' + frontmatter + '\n---\n\n' + body;
  writeFileSync(join(dir, 'SKILL.md'), text, 'utf8');
  return dir;
}

const GOOD = [
  'name: good-skill',
  'description: A well formed skill used as the happy path fixture for the quality gate.',
  'version: 1.0.0',
  'requires: node',
  'tests: manual: read the skill and follow it once end to end',
  'provenance: original',
].join('\n');

test('frontmatter 解析：扁平字段 + metadata 嵌套回退', () => {
  const fm = parseFrontmatter('---\nname: x\nmetadata:\n  version: "2.6"\n---\nbody');
  assert.equal(fm.present, true);
  assert.equal(fm.fields.name, 'x');
  assert.equal(fm.fields.metadata.version, '2.6');
  const flat = parseFrontmatter('no frontmatter here');
  assert.equal(flat.present, false);
});

test('合规技能零错误零告警', () => {
  const r = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD + '\n---\n\n# x\n' });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.errors.length, 0);
  assert.equal(r.warnings.length, 0);
  assert.equal(r.meta.versionNormalized, '1.0.0');
  assert.equal(r.meta.provenanceKind, 'original');
});

test('缺 frontmatter 判不合规', () => {
  const r = validateSkill({ dirName: 'x', raw: '# 只有正文\n' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('缺 frontmatter')));
});

test('缺 version / 坏 semver 均判不合规', () => {
  const noVer = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.split('\n').filter(l => !l.startsWith('version:')).join('\n') + '\n---\n' });
  assert.equal(noVer.ok, false);
  assert.ok(noVer.errors.some(e => e.includes('缺 version')));

  const badVer = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('version: 1.0.0', 'version: v1') + '\n---\n' });
  assert.equal(badVer.ok, false);
  assert.ok(badVer.errors.some(e => e.includes('version 非法')));
});

test('metadata.version 回退可用但降级为告警', () => {
  const raw = '---\nname: good-skill\ndescription: ' + 'x'.repeat(40) +
    '\nmetadata:\n  version: "2.6"\nrequires: node\ntests: manual: check\nprovenance: original\n---\n';
  const r = validateSkill({ dirName: 'good-skill', raw });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.meta.versionNormalized, '2.6.0');
  assert.ok(r.warnings.some(w => w.includes('metadata.version')));
});

test('name 与目录名不一致判不合规', () => {
  const r = validateSkill({ dirName: 'other-dir', raw: '---\n' + GOOD + '\n---\n' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('name 与目录名不一致')));
});

test('requires 缺失 / 空 / 含 shell 元字符均判不合规', () => {
  const noReq = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.split('\n').filter(l => !l.startsWith('requires:')).join('\n') + '\n---\n' });
  assert.equal(noReq.ok, false);
  assert.ok(noReq.errors.some(e => e.includes('缺 requires')));

  const meta = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('requires: node', 'requires: node && rm -rf /') + '\n---\n' });
  assert.equal(meta.ok, false);
  assert.ok(meta.errors.some(e => e.includes('shell 元字符')));
});

test('tests 指向不存在的测试文件判不合规', () => {
  const r = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('tests: manual: read the skill and follow it once end to end', 'tests: node --test orchestrator/test/does-not-exist-xyz.test.mjs') + '\n---\n' });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes('测试文件不存在')));
});

test('provenance 缺 ref / 语法非法判不合规', () => {
  const noRef = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('provenance: original', 'provenance: adapted:mattpocock/skills') + '\n---\n' });
  assert.equal(noRef.ok, false);
  assert.ok(noRef.errors.some(e => e.includes('provenance 缺 ref')));

  const junk = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('provenance: original', 'provenance: 随便写的') + '\n---\n' });
  assert.equal(junk.ok, false);
  assert.ok(junk.errors.some(e => e.includes('provenance 非法')));
});

test('description 长度越界判不合规', () => {
  const short = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace('description: A well formed skill used as the happy path fixture for the quality gate.', 'description: 太短') + '\n---\n' });
  assert.equal(short.ok, false);
  const long = validateSkill({ dirName: 'good-skill', raw: '---\n' + GOOD.replace(/description: .*/, 'description: ' + 'x'.repeat(1300)) + '\n---\n' });
  assert.equal(long.ok, false);
});

test('扫描夹具目录：合规与不合规分别计数', () => {
  const root = tmpRoot();
  try {
    makeSkill(root, 'good-skill', GOOD);
    makeSkill(root, 'bad-skill', GOOD.replace('version: 1.0.0', 'version: nope'));
    const r = scanSkills({ skillsRoot: root, repoRoot: REPO_ROOT });
    assert.equal(r.total, 2);
    assert.equal(r.passed, 1);
    assert.equal(r.failed, 1);
    assert.equal(r.skills.find(s => s.name === 'bad-skill').ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('必填字段集合固定为 6 项', () => {
  assert.deepEqual([...REQUIRED_FIELDS], ['name', 'description', 'version', 'requires', 'tests', 'provenance']);
});

test('仓内全部技能通过质量门（回归：新增技能必须补齐元数据）', () => {
  const r = scanSkills({ skillsRoot: join(REPO_ROOT, '.agents', 'skills'), repoRoot: REPO_ROOT });
  // T-183（2026-10-22 技能整合）：21 → 15（同族合并 + 删纯别名），下限随之下调；
  // 仍保留护栏：低于 15 说明技能被误删，要查。
  assert.ok(r.total >= 15, '技能数量异常：' + r.total);
  const bad = r.skills.filter(s => !s.ok).map(s => s.name + ': ' + s.errors.join('; '));
  assert.deepEqual(bad, [], '不合规技能：\n' + bad.join('\n'));
});

test('CLI：全绿退出码 0，坏技能退出码 1 且打印原因', () => {
  const ok = spawnSync(process.execPath, [CLI], { cwd: REPO_ROOT, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /RESULT: OK/);

  const root = tmpRoot();
  try {
    makeSkill(root, 'bad-skill', GOOD.replace('version: 1.0.0', 'version: nope'));
    const bad = spawnSync(process.execPath, [CLI, '--skills-dir', root], { cwd: REPO_ROOT, encoding: 'utf8' });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /FAIL bad-skill/);
    assert.match(bad.stdout, /RESULT: FAIL/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
