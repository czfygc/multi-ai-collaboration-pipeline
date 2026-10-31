// T-151: 技能 manifest 回归 —— 条目生成 / 差异比对 / CAS 与并发冲突显式失败 / 一致性校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildSkillEntry, buildManifest, compareManifest, readManifest, applyManifest, verifyManifest,
  parseProvenance, MANIFEST_SCHEMA_VERSION, DEFAULT_SKILLS_ROOT, DEFAULT_MANIFEST_PATH,
} from '../lib/skill-manifest.mjs';
import { sha256OfText } from '../lib/lock.mjs';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CLI = fileURLToPath(new URL('../skill-manifest.mjs', import.meta.url));

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 't151-manifest-'));
  const skills = join(root, 'skills');
  mkdirSync(skills, { recursive: true });
  return { root, skills, manifestPath: join(root, 'SKILL_MANIFEST.json') };
}

function makeSkill(skills, name, { version = '1.0.0', provenance = 'original', extra = '', body = '# s\n' } = {}) {
  const dir = join(skills, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), [
    '---',
    'name: ' + name,
    'description: A fixture skill used by the skill manifest unit tests for coverage.',
    'version: ' + version,
    'requires: node',
    'tests: manual: check it once end to end',
    'provenance: ' + provenance,
    extra,
    '---',
    '',
    body,
  ].join('\n'), 'utf8');
  return dir;
}

test('provenance 拆解：original / adapted / vendored / 非法', () => {
  assert.deepEqual(parseProvenance('original'), { kind: 'original', origin: '', ref: '' });
  assert.deepEqual(parseProvenance('adapted:mattpocock/skills#unversioned-MIT'), { kind: 'adapted', origin: 'mattpocock/skills', ref: 'unversioned-MIT' });
  assert.deepEqual(parseProvenance('vendored:cathrynlavery/diagram-design#f2f4d49'), { kind: 'vendored', origin: 'cathrynlavery/diagram-design', ref: 'f2f4d49' });
  assert.equal(parseProvenance('随便写的').kind, 'unknown');
  assert.equal(parseProvenance('').kind, 'unknown');
});

test('条目生成：name/slug/version/source/sha256/treeSha256/entrypoints/readOnly', () => {
  const { skills } = sandbox();
  try {
    const dir = makeSkill(skills, 'demo-skill', { provenance: 'adapted:src/repo#v1' });
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'a.md'), 'ref\n', 'utf8');
    const e = buildSkillEntry(dir, { skillsRoot: skills });
    assert.equal(e.name, 'demo-skill');
    assert.equal(e.slug, 'demo-skill');
    assert.equal(e.version, '1.0.0');
    assert.equal(e.source.kind, 'adapted');
    assert.equal(e.source.ref, 'v1');
    assert.equal(e.readOnly, true);
    assert.equal(e.sha256.length, 64);
    assert.equal(e.treeSha256.length, 64);
    assert.deepEqual(e.entrypoints, ['SKILL.md', 'references/a.md']);
    // 内容变了 → sha/tree 变
    const before = e.sha256;
    writeFileSync(join(dir, 'SKILL.md'), 'changed\n', 'utf8');
    const e2 = buildSkillEntry(dir, { skillsRoot: skills });
    assert.notEqual(e2.sha256, before);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('readOnly：默认 true；显式 write: true 才记 false', () => {
  const { skills } = sandbox();
  try {
    const a = makeSkill(skills, 'ro-skill');
    const b = makeSkill(skills, 'rw-skill', { extra: 'write: true' });
    assert.equal(buildSkillEntry(a, { skillsRoot: skills }).readOnly, true);
    assert.equal(buildSkillEntry(b, { skillsRoot: skills }).readOnly, false);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('manifest 生成：只含带 SKILL.md 的目录，条目按名排序', () => {
  const { skills } = sandbox();
  try {
    makeSkill(skills, 'b-skill');
    makeSkill(skills, 'a-skill');
    mkdirSync(join(skills, 'not-a-skill'), { recursive: true });
    const m = buildManifest({ skillsRoot: skills });
    assert.equal(m.schemaVersion, MANIFEST_SCHEMA_VERSION);
    assert.equal(m.skills.length, 2);
    assert.deepEqual(m.skills.map(s => s.name), ['a-skill', 'b-skill']);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('差异比对：新增/变更/移除/未变', () => {
  const { skills } = sandbox();
  try {
    makeSkill(skills, 'a-skill');
    makeSkill(skills, 'b-skill');
    const m = buildManifest({ skillsRoot: skills });
    const d1 = compareManifest(m, buildManifest({ skillsRoot: skills }).skills);
    assert.deepEqual(d1.added, []);
    assert.deepEqual(d1.changed, []);
    assert.deepEqual(d1.removed, []);
    assert.equal(d1.unchanged.length, 2);
    // 改一个 + 删一个 + 加一个
    writeFileSync(join(skills, 'b-skill', 'SKILL.md'), 'v2\n', 'utf8');
    rmSync(join(skills, 'a-skill'), { recursive: true, force: true });
    makeSkill(skills, 'c-skill');
    const d2 = compareManifest(m, buildManifest({ skillsRoot: skills }).skills);
    assert.deepEqual(d2.added, ['c-skill']);
    assert.deepEqual(d2.changed, ['b-skill']);
    assert.deepEqual(d2.removed, ['a-skill']);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('apply：落盘后可回读；CAS 期望哈希不符 → 显式冲突失败', () => {
  const { skills, manifestPath } = sandbox();
  try {
    makeSkill(skills, 'a-skill');
    const r = applyManifest({ manifestPath, skillsRoot: skills });
    assert.equal(r.ok, true);
    assert.equal(r.status, 'written');
    const m = readManifest(manifestPath);
    assert.equal(m.skills.length, 1);
    assert.ok(!existsSync(manifestPath + '.tmp'), '不应残留 tmp 文件');
    const bad = applyManifest({ manifestPath, skillsRoot: skills, expectSha256: 'deadbeef' });
    assert.equal(bad.ok, false);
    assert.equal(bad.status, 'conflict');
    assert.match(bad.detail, /CAS/);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('apply：并发写冲突显式失败（CAS 期望哈希已过期）', () => {
  const { skills, manifestPath } = sandbox();
  try {
    makeSkill(skills, 'a-skill');
    applyManifest({ manifestPath, skillsRoot: skills });
    const staleHash = sha256OfText(readFileSync(manifestPath, 'utf8')); // 旧版本哈希
    // 他端先写了一次
    makeSkill(skills, 'b-skill');
    applyManifest({ manifestPath, skillsRoot: skills });
    // 我方拿着旧哈希再写 → 必须冲突（不静默覆盖）
    const r = applyManifest({ manifestPath, skillsRoot: skills, expectSha256: staleHash });
    assert.equal(r.ok, false);
    assert.equal(r.status, 'conflict');
    assert.match(r.detail, /CAS/);
    // 且磁盘内容仍是「他端」那版（没被覆盖）
    assert.equal(readManifest(manifestPath).skills.length, 2);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('verify：一致则 ok；技能内容变了则报不一致', () => {
  const { skills, manifestPath } = sandbox();
  try {
    makeSkill(skills, 'a-skill');
    applyManifest({ manifestPath, skillsRoot: skills });
    const ok = verifyManifest({ manifestPath, skillsRoot: skills });
    assert.equal(ok.ok, true, JSON.stringify(ok.issues));
    writeFileSync(join(skills, 'a-skill', 'SKILL.md'), 'changed\n', 'utf8');
    const bad = verifyManifest({ manifestPath, skillsRoot: skills });
    assert.equal(bad.ok, false);
    assert.ok(bad.issues.some(i => i.includes('内容已变')));
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});

test('仓内真实技能：manifest 覆盖全部技能且与磁盘一致', () => {
  const m = readManifest(DEFAULT_MANIFEST_PATH);
  assert.ok(m, '仓内 manifest 不存在（先跑 node orchestrator/skill-manifest.mjs apply）');
  // T-183（2026-10-22 技能整合）：21 → 15（同族合并 + 删纯别名），下限随之下调；
  // 仍保留护栏：低于 15 说明技能被误删，要查。
  assert.ok(m.skills.length >= 15, '技能数异常: ' + m.skills.length);
  const v = verifyManifest({ manifestPath: DEFAULT_MANIFEST_PATH, skillsRoot: DEFAULT_SKILLS_ROOT });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('CLI：status/build/verify 可用；apply 落盘', () => {
  const { skills, manifestPath } = sandbox();
  try {
    makeSkill(skills, 'a-skill');
    const st = spawnSync(process.execPath, [CLI, 'status', '--skills-root', skills, '--manifest', manifestPath, '--json'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(st.status, 0, st.stdout + st.stderr);
    const parsed = JSON.parse(st.stdout);
    assert.equal(parsed.present, false);
    assert.deepEqual(parsed.added, ['a-skill']);
    const ap = spawnSync(process.execPath, [CLI, 'apply', '--skills-root', skills, '--manifest', manifestPath], { encoding: 'utf8', timeout: 120000 });
    assert.equal(ap.status, 0, ap.stdout + ap.stderr);
    const vf = spawnSync(process.execPath, [CLI, 'verify', '--skills-root', skills, '--manifest', manifestPath], { encoding: 'utf8', timeout: 120000 });
    assert.equal(vf.status, 0, vf.stdout + vf.stderr);
    const bad = spawnSync(process.execPath, [CLI, 'apply', '--skills-root', skills, '--manifest', manifestPath, '--expect-sha256', 'deadbeef'], { encoding: 'utf8', timeout: 120000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stdout + bad.stderr, /conflict|CAS/);
  } finally {
    rmSync(skills, { recursive: true, force: true });
  }
});
