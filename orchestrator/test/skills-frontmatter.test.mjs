// T-146: .agents/skills 前端元数据回归 —— 目录名=name、description 可用、T-146 五个技能在位
// T-155: 接入技能质量门 —— version/requires/tests/provenance 四字段必填且可机器校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSkill, REQUIRED_FIELDS } from '../lib/skill-quality.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const SKILLS_DIR = fileURLToPath(new URL('../../.agents/skills', import.meta.url));
const T146 = [
  'titan-grilling',
  'titan-tdd',
  'titan-diagnosing-bugs',
  'titan-code-review',
  'titan-handoff',
];

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  const fields = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return fields;
}

function skillDirs() {
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => existsSync(join(SKILLS_DIR, name, 'SKILL.md')));
}

test('每个技能目录：frontmatter 可解析且 name 与目录一致（T-155 起全量强制）', () => {
  const dirs = skillDirs();
  assert.ok(dirs.length >= T146.length, '技能目录数异常: ' + dirs.length);
  for (const name of dirs) {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    const raw = readFileSync(file, 'utf8');
    assert.ok(!raw.startsWith('\uFEFF'), name + ': SKILL.md 不应带 BOM');
    const fm = parseFrontmatter(raw);
    assert.ok(fm, name + ': 缺 frontmatter（T-155 起不再豁免存量）');
    assert.equal(fm.name, name, name + ': frontmatter name 与目录不一致 -> ' + fm.name);
    assert.ok(fm.description && fm.description.length >= 20, name + ': description 太短或缺失');
    assert.ok(fm.description.length <= 1200, name + ': description 过长 -> ' + fm.description.length);
  }
});

test('T-155 技能质量字段：version/requires/tests/provenance 齐全且合法', () => {
  const dirs = skillDirs();
  for (const name of dirs) {
    const raw = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const r = validateSkill({ dirName: name, raw, repoRoot: REPO_ROOT });
    assert.equal(r.ok, true, name + ': 质量门不合规 -> ' + r.errors.join('; '));
    for (const key of ['version', 'requires', 'tests', 'provenance']) {
      assert.ok(REQUIRED_FIELDS.includes(key), '必填字段表缺 ' + key);
      assert.ok(r.meta[key], name + ': 质量字段 ' + key + ' 为空');
    }
  }
});

test('T-146 五个工程技能在位且非空', () => {
  for (const name of T146) {
    const file = join(SKILLS_DIR, name, 'SKILL.md');
    assert.ok(existsSync(file), '缺失技能: ' + name);
    assert.ok(statSync(file).size > 800, name + ': 内容过少，可能是空壳');
  }
});

test('T-146 技能标注上游 MIT 来源', () => {
  for (const name of T146) {
    const raw = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    assert.match(raw, /mattpocock\/skills/, name + ': 未标注上游来源');
    assert.match(raw, /MIT/, name + ': 未标注 MIT 许可');
  }
});

test('frontmatter 须为合法 YAML：未加引号的值不得含 ": "（T-215 回归）', () => {
  // 背景（T-215）：dsh-skill-filesystem 用严格 YAML 解析 frontmatter；`tests: manual: xxx`
  // 这类**未加引号且含 ": "** 的值会解析报错（Nested mappings are not allowed in compact
  // mappings）→ 该技能被静默忽略 → 强制附加技能也拿不到 payload（曾致 11 个共用技能失效）。
  // 本测试按 YAML 块映射规则做定向校验：非引号包裹的值若含 ": " 即判非法。
  const dirs = skillDirs();
  assert.ok(dirs.length > 0, '技能目录为空');
  for (const name of dirs) {
    const raw = readFileSync(join(SKILLS_DIR, name, 'SKILL.md'), 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(fm, name + ': 缺 frontmatter');
    for (const line of fm[1].split(/\r?\n/)) {
      const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (!kv) continue;                        // 缩进行（嵌套映射）或非键值行 → 跳过
      const value = kv[2].trim();
      if (value === '') continue;               // 空值 → 可能是嵌套映射
      if (/^["'].*["']$/.test(value)) continue; // 已加引号 → 合法
      assert.ok(
        !value.includes(': '),
        `${name}: frontmatter 字段 "${kv[1]}" 的值含未加引号的 ": "（YAML 非法，DSH 会忽略该技能）→ 请加引号`,
      );
    }
  }
});

test('工作流索引覆盖全部五个技能并与 M1-M7 分工', () => {
  const file = join(SKILLS_DIR, 'ENGINEERING-WORKFLOW.md');
  assert.ok(existsSync(file), '缺少 ENGINEERING-WORKFLOW.md');
  const raw = readFileSync(file, 'utf8');
  for (const name of T146) assert.ok(raw.includes(name), '索引未列出 ' + name);
  assert.match(raw, /职责分工/, '索引缺少职责分工表');
  assert.match(raw, /M1-M7/, '索引未声明与 M1-M7 的关系');
});
