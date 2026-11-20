#!/usr/bin/env node
// orchestrator/skill-manifest.mjs — T-151 技能 manifest CLI（只读生成器 + 内容寻址发布）
// 用法:
//   node orchestrator/skill-manifest.mjs status  [--json]                 只读：manifest 与磁盘的差异
//   node orchestrator/skill-manifest.mjs build   [--write] [--json]        生成 manifest（默认只打印）
//   node orchestrator/skill-manifest.mjs apply   [--expect-sha256 <hex>] [--json]
//                                                               落盘（锁 + CAS；并发写冲突显式失败）
//   node orchestrator/skill-manifest.mjs verify  [--json]                 校验 manifest 与磁盘一致
//   node orchestrator/skill-manifest.mjs registry [--write] [--json]       生成/落盘 registry.json
//   node orchestrator/skill-manifest.mjs categories [--write] [--json]     生成/落盘 categories.json
//   node orchestrator/skill-manifest.mjs verify-registry [--json]          校验 registry.json
//   node orchestrator/skill-manifest.mjs verify-categories [--json]        校验 categories.json
// 退出码: 0=成功, 1=失败/冲突/不一致, 2=用法错误
//
// 红线：只读技能目录；不改目录式发现方式；并发写冲突显式失败不静默覆盖。

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildManifest, compareManifest, readManifest, applyManifest, verifyManifest,
  DEFAULT_SKILLS_ROOT, DEFAULT_MANIFEST_PATH,
  buildRegistry, buildCategories, applyRegistry, applyCategories, verifyRegistry, verifyCategories,
} from './lib/skill-manifest.mjs';
import { sha256OfText } from './lib/lock.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0] || '';
function flagValue(name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  const v = argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}
const asJson = argv.includes('--json');
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const skillsRoot = resolve(flagValue('--skills-root') || DEFAULT_SKILLS_ROOT);
const manifestPath = resolve(flagValue('--manifest') || DEFAULT_MANIFEST_PATH);
const registryPath = resolve(flagValue('--registry') || DEFAULT_SKILLS_ROOT + '/registry.json');
const categoriesPath = resolve(flagValue('--categories') || DEFAULT_SKILLS_ROOT + '/categories.json');

if (!cmd || argv.includes('--help') || argv.includes('-h')) {
  console.log([
    '用法: node orchestrator/skill-manifest.mjs <status|build|apply|verify|registry|categories|verify-registry|verify-categories> [options]',
    '  --skills-root <dir>   技能目录（默认 .agents/skills）',
    '  --manifest <file>     manifest 路径（默认 .agents/skills/SKILL_MANIFEST.json）',
    '  --registry <file>     registry.json 路径（默认 .agents/skills/registry.json）',
    '  --categories <file>   categories.json 路径（默认 .agents/skills/categories.json）',
    '  --write               build/registry/categories 时直接落盘',
    '  --expect-sha256 <hex> apply 时的 CAS 期望哈希（不符=并发冲突，拒写）',
    '  --json                输出 JSON',
    '退出码: 0=成功 1=失败/冲突/不一致 2=用法错误',
  ].join('\n'));
  process.exit(cmd ? 0 : 2);
}

if (cmd === 'status') {
  const manifest = readManifest(manifestPath);
  const entries = buildManifest({ skillsRoot }).skills;
  const diff = compareManifest(manifest, entries);
  if (asJson) {
    console.log(JSON.stringify({ manifestPath, present: !!manifest, ...diff }, null, 2));
  } else {
    console.log('[SKILL-MANIFEST] manifest: ' + manifestPath + (manifest ? '' : '（尚不存在）'));
    console.log('[SKILL-MANIFEST] 技能 ' + entries.length + ' 个：新增 ' + diff.added.length +
      '，变更 ' + diff.changed.length + '，移除 ' + diff.removed.length + '，未变 ' + diff.unchanged.length);
    for (const n of diff.added) console.log('  + ' + n);
    for (const n of diff.changed) console.log('  ~ ' + n);
    for (const n of diff.removed) console.log('  - ' + n);
  }
  process.exit(0);
}

if (cmd === 'build') {
  const manifest = buildManifest({ skillsRoot });
  if (argv.includes('--write')) {
    const r = applyManifest({ manifestPath, skillsRoot });
    if (!r.ok) { console.error('[SKILL-MANIFEST] 写入失败（' + r.status + '）: ' + (r.detail || '')); process.exit(1); }
    console.log('[SKILL-MANIFEST] 已写入 ' + r.path + '（' + r.manifest.skills.length + ' 个技能，revision=' + r.revision.slice(0, 12) + '…）');
    process.exit(0);
  }
  if (asJson) console.log(JSON.stringify(manifest, null, 2));
  else {
    console.log('[SKILL-MANIFEST] 预演（未落盘）：' + manifest.skills.length + ' 个技能');
    for (const s of manifest.skills) {
      console.log('  ' + s.name + ' v' + s.version + ' sha=' + s.sha256.slice(0, 12) + '… readOnly=' + s.readOnly + ' src=' + s.source.kind);
    }
  }
  process.exit(0);
}

if (cmd === 'apply') {
  const expect = flagValue('--expect-sha256');
  const r = applyManifest({ manifestPath, skillsRoot, expectSha256: expect });
  if (!r.ok) {
    console.error('[SKILL-MANIFEST] ' + r.status + ': ' + (r.detail || ''));
    process.exit(1);
  }
  console.log('[SKILL-MANIFEST] 已写入 ' + r.path + '（' + r.manifest.skills.length + ' 个技能，revision=' + r.revision.slice(0, 12) + '…）');
  process.exit(0);
}

if (cmd === 'verify') {
  const r = verifyManifest({ manifestPath, skillsRoot });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.ok) console.log('[SKILL-MANIFEST] manifest 与磁盘一致（' + manifestPath + '）');
    else for (const i of r.issues) console.error('[SKILL-MANIFEST] ' + i);
  }
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'registry') {
  const registry = buildRegistry({ skillsRoot });
  if (argv.includes('--write')) {
    const r = applyRegistry({ registryPath, skillsRoot });
    if (!r.ok) { console.error('[SKILL-MANIFEST] registry 写入失败: ' + r.detail); process.exit(1); }
    console.log('[SKILL-MANIFEST] registry.json 已写入 ' + r.path + '（' + registry.skills.length + ' 个技能）');
    process.exit(0);
  }
  if (asJson) console.log(JSON.stringify(registry, null, 2));
  else {
    console.log('[SKILL-MANIFEST] registry 预演：' + registry.skills.length + ' 个技能');
    for (const s of registry.skills) {
      console.log('  ' + s.name + ' [' + s.category + '] triggers=' + s.triggers.join(',') + ' alwaysAttach=' + s.alwaysAttach);
    }
  }
  process.exit(0);
}

if (cmd === 'categories') {
  const categories = buildCategories({ skillsRoot });
  if (argv.includes('--write')) {
    const r = applyCategories({ categoriesPath, skillsRoot });
    if (!r.ok) { console.error('[SKILL-MANIFEST] categories 写入失败: ' + r.detail); process.exit(1); }
    console.log('[SKILL-MANIFEST] categories.json 已写入 ' + r.path + '（' + Object.keys(categories.categories).length + ' 个分类）');
    process.exit(0);
  }
  if (asJson) console.log(JSON.stringify(categories, null, 2));
  else {
    console.log('[SKILL-MANIFEST] categories 预演：' + Object.keys(categories.categories).length + ' 个分类');
    for (const [cat, data] of Object.entries(categories.categories)) {
      console.log('  ' + cat + ' (' + data.label + '): ' + data.skills.length + ' 技能');
    }
  }
  process.exit(0);
}

if (cmd === 'verify-registry') {
  const r = verifyRegistry({ registryPath, skillsRoot });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.ok) console.log('[SKILL-MANIFEST] registry.json 与磁盘一致（' + registryPath + '）');
    else for (const i of r.issues) console.error('[SKILL-MANIFEST] ' + i);
  }
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'verify-categories') {
  const r = verifyCategories({ categoriesPath, skillsRoot });
  if (asJson) console.log(JSON.stringify(r, null, 2));
  else {
    if (r.ok) console.log('[SKILL-MANIFEST] categories.json 与磁盘一致（' + categoriesPath + '）');
    else for (const i of r.issues) console.error('[SKILL-MANIFEST] ' + i);
  }
  process.exit(r.ok ? 0 : 1);
}

console.error('未知命令: ' + cmd + '（可用: status|build|apply|verify|registry|categories|verify-registry|verify-categories）');
process.exit(2);
