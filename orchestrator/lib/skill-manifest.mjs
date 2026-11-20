// orchestrator/lib/skill-manifest.mjs — T-151 技能/插件 manifest（只读生成器 + 内容寻址发布）
//
// 目标（借鉴 cursor/plugins 的 .cursor-plugin/plugin.json + claude-plugins-official 的
//       immutable slug / renames / skill-bundle）：给 .agents/skills/ 建一份**并行事实源**，
//       记录每个技能的 name/slug/version/source/sha256/entrypoints/readOnly，
//       供四客户端与发布流程做「内容寻址（CAS）+ 并发写冲突显式失败」。
//
// 红线（台账 T-151 原文）：
//   1. **不改目录式技能发现方式**——.agents/skills/*/SKILL.md 仍是唯一发现入口；
//      manifest 只是旁路事实源，不接管加载、不替换任何东西。
//   2. 生成器**只读**技能目录；只写 manifest 文件本身。
//   3. 并发写冲突**显式失败**（不静默覆盖他人改动）：锁 + baseSnapshot 比对 + 可选 CAS 期望哈希。
//   4. 不改技能正文；readOnly 默认 true（只读），技能可显式声明 write: true 才记 false。
//
// 字段来源：frontmatter 六字段沿用 T-155 技能质量门（name/description/version/requires/tests/provenance），
//           另加本模块专属的 sha256 / treeSha256 / entrypoints / readOnly / source 拆解。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from './skill-quality.mjs';
import { withLockedJsonWrite, sha256OfText } from './lock.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const MANIFEST_SCHEMA_VERSION = 'v1';
export const DEFAULT_SKILLS_ROOT = join(REPO_ROOT, '.agents', 'skills');
export const DEFAULT_MANIFEST_PATH = join(DEFAULT_SKILLS_ROOT, 'SKILL_MANIFEST.json');
export const DEFAULT_REGISTRY_PATH = join(DEFAULT_SKILLS_ROOT, 'registry.json');
export const DEFAULT_CATEGORIES_PATH = join(DEFAULT_SKILLS_ROOT, 'categories.json');
export const SKIP_ENTRY_DIRS = new Set(['node_modules', '.git', '__pycache__']);

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// 技能目录内的文件清单（相对路径，去点目录），用于 entrypoints
export function listSkillFiles(skillDir) {
  const out = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_ENTRY_DIRS.has(e.name)) continue;
        walk(p, depth + 1);
      } else if (e.isFile()) {
        out.push(relative(skillDir, p).split('\\').join('/'));
      }
    }
  };
  walk(skillDir, 0);
  return out.sort();
}

// provenance 字符串拆解：original | adapted:<src>#<ref> | vendored:<src>#<ref>
export function parseProvenance(value) {
  const v = String(value || '').trim();
  if (!v) return { kind: 'unknown', origin: '', ref: '' };
  if (v === 'original') return { kind: 'original', origin: '', ref: '' };
  const m = v.match(/^(adapted|vendored):\s*(\S+?)(?:#(\S+))?$/);
  if (!m) return { kind: 'unknown', origin: v, ref: '' };
  return { kind: m[1], origin: m[2], ref: m[3] || '' };
}

// 单技能条目（只读扫描）
export function buildSkillEntry(skillDir, { skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const name = skillDir.split(/[\\/]/).pop();
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  const fm = parseFrontmatter(raw.toString('utf8'));
  const f = fm.fields || {};
  const files = listSkillFiles(skillDir);
  const treeParts = files.map((rel) => {
    const abs = join(skillDir, rel);
    let h = '';
    try { h = sha256(readFileSync(abs)); } catch { h = 'unreadable'; }
    return rel + ':' + h;
  });
  return {
    name: f.name || name,
    slug: f.name || name,
    version: typeof f.version === 'string' ? f.version : '',
    source: parseProvenance(f.provenance),
    sha256: sha256(raw),
    treeSha256: sha256(treeParts.join('\n')),
    entrypoints: files,
    readOnly: !(typeof f.write === 'string' && f.write.toLowerCase() === 'true'),
    requires: typeof f.requires === 'string' ? f.requires : '',
    tests: typeof f.tests === 'string' ? f.tests : '',
    provenance: typeof f.provenance === 'string' ? f.provenance : '',
    description: typeof f.description === 'string' ? f.description : '',
  };
}

// 扫全部技能 → manifest
export function buildManifest({ skillsRoot = DEFAULT_SKILLS_ROOT, base = null } = {}) {
  const root = resolve(skillsRoot);
  const entries = [];
  if (existsSync(root)) {
    for (const d of readdirSync(root, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const entry = buildSkillEntry(join(root, d.name), { skillsRoot: root });
      if (entry) entries.push(entry);
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    generator: 'orchestrator/skill-manifest.mjs',
    baseRevision: base ? base.revision || null : null,
    skills: entries,
  };
}

// manifest ↔ 磁盘差异（added / removed / changed / unchanged）
export function compareManifest(manifest, entries) {
  const old = new Map((manifest && manifest.skills ? manifest.skills : []).map(s => [s.name, s]));
  const cur = new Map(entries.map(s => [s.name, s]));
  const added = [];
  const changed = [];
  const unchanged = [];
  for (const [name, e] of cur) {
    const o = old.get(name);
    if (!o) { added.push(name); continue; }
    if (o.sha256 !== e.sha256 || o.treeSha256 !== e.treeSha256 || o.version !== e.version) changed.push(name);
    else unchanged.push(name);
  }
  const removed = [...old.keys()].filter(n => !cur.has(n));
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort(), unchanged: unchanged.sort() };
}

export function readManifest(manifestPath = DEFAULT_MANIFEST_PATH) {
  if (!existsSync(manifestPath)) return null;
  try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

// 写入（锁 + baseSnapshot 比对 + CAS 期望哈希 → 并发写冲突显式失败）
// expectSha256 语义：调用方看到的 manifest 版本哈希（CAS 期望值）。不符 = 他端已改 → 拒写。
export function applyManifest({
  manifestPath = DEFAULT_MANIFEST_PATH, skillsRoot = DEFAULT_SKILLS_ROOT,
  expectSha256 = null, generator = 'orchestrator/skill-manifest.mjs',
} = {}) {
  const current = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  const currentHash = sha256OfText(current);
  if (expectSha256 && expectSha256 !== currentHash) {
    return {
      ok: false,
      status: 'conflict',
      detail: 'CAS 期望哈希不符（manifest 已被他端改动）：期望 ' + expectSha256 + '，实际 ' + currentHash + '。请重读后重试。',
    };
  }
  const result = withLockedJsonWrite(manifestPath, {
    // 锁内重读比对：他端在「读」与「写」之间改了 manifest → 冲突，拒绝覆盖
    baseSnapshot: currentHash,
    lockPath: manifestPath + '.write.lock',
    produceDoc: () => {
      const m = buildManifest({ skillsRoot, base: { revision: currentHash } });
      m.generator = generator;
      return m;
    },
  });
  if (result.ok) {
    const m = readManifest(manifestPath);
    return { ok: true, status: 'written', manifest: m, path: manifestPath, revision: sha256OfText(readFileSync(manifestPath, 'utf8')) };
  }
  return { ...result, path: manifestPath };
}

// 校验：manifest 与磁盘一致？（CI/verify 用）
export function verifyManifest({ manifestPath = DEFAULT_MANIFEST_PATH, skillsRoot = DEFAULT_SKILLS_ROOT } = {}) {
  const manifest = readManifest(manifestPath);
  if (!manifest) return { ok: false, issues: ['manifest 不存在: ' + manifestPath], diff: null };
  const issues = [];
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) issues.push('schemaVersion 不匹配: ' + manifest.schemaVersion);
  const entries = buildManifest({ skillsRoot }).skills;
  const diff = compareManifest(manifest, entries);
  if (diff.added.length) issues.push('未登记的技能: ' + diff.added.join(', '));
  if (diff.removed.length) issues.push('manifest 里已不存在的技能: ' + diff.removed.join(', '));
  if (diff.changed.length) issues.push('内容已变（需重新 build/apply）: ' + diff.changed.join(', '));
  return { ok: issues.length === 0, issues, diff };
}

// ---------- AGENTS.md M7 表解析：提取分组与触发词 ----------

const GROUP_TO_CATEGORY = {
  '调用验证': 'invocation',
  '评审': 'review',
  '排障': 'diagnostics',
  '开发': 'development',
  '台账': 'ledger',
  '流程': 'process',
  '运维': 'ops',
  '浏览器': 'browser',
  '工具': 'tools',
  '量化': 'quantitative-research',
  '图表': 'diagrams',
};

// 显式触发词映射（补全 AGENTS.md 中未写"触发词："的技能）
const EXPLICIT_TRIGGERS = {
  'titan-code-review': ['评审', '复查', 'review', '代码评审'],
  'titan-four-party-consult': ['4会诊', '交叉审问', '多方复核', '会诊'],
  'decision-matrix': ['加权评分', '决策矩阵', '利弊分析', 'ICE优先级', '前瞻分析'],
  'titan-diagnosing-bugs': ['诊断', '查bug', '为什么报错', '变慢了', '挂死', '先Google搜'],
  'titan-tdd': ['TDD', '红绿重构', '先写测试', '加回归测试', '跑测试'],
  'zero-slop': ['去冗余', '人性化', '散文审计', 'de-slop', '质量闸'],
  'titan-complex-implementation': ['写复杂逻辑', '改多个文件', '重构', '新增子系统', '动执行链'],
  'titan-registry-edit': ['登记任务', '更新台账', '改台账', '记住这个'],
  'titan-parallel-delegation': ['并行', '委派', '分给别的客户端', '派活', '协作'],
  'titan-grilling': ['盘问我', '格栅', '把需求问清楚', 'grill'],
  'titan-handoff': ['交接', '写交接文档', '换个会话继续'],
  'titan-evidence-before-claims': ['完成', '已修复', '全绿', '可以提交', '改台账done'],
  'titan-session-retro': ['会话快结束', '事故收尾', '复盘收尾'],
  'titan-publish-sync': ['更新发布', '同步发布', '推GitHub', '发Release'],
  'titan-cleanup': ['大扫除', '整合清理', '腾空间', '清理硬盘'],
  'titan-snapshot-rollback': ['快照', '回滚', '装插件前', '改配置前'],
  'documentation-writer': ['写文档', 'Diátaxis', '技术文档', 'README'],
  'titan-cdp-browser-ops': ['浏览器操作', 'CDP', '注册账号', '填表'],
  'titan-plugin-mining': ['挖插件', '挖技能', 'plugin mining'],
  'titan-best-practices': ['最佳实践', '避坑指南', '按需加载', '技能路由'],
  'cue-omni-reader': ['解析URL', 'Cue Omni', '文档解析'],
  'nodekit-staleness-checklist': ['nodekit', '改py重启3003'],
  'titan-quant-tool-discipline': ['量化', '回测', '因子', 'IC', 'Sharpe'],
  'diagram-design': ['画图', '架构图', '流程图', '时序图', '泳道图'],
  'titan-skill-evolution': ['复盘收尾', '沉淀四件套', '演进技能', '技能回测'],
  'titan-gate-triage': ['闸门红', 'verify-gate失败', '假红', '红项归属', '修闸门'],
  'titan-secret-hygiene': ['密钥', '凭据', '泄露', 'secret scan', '轮换'],
  'titan-headless-clients': ['后台调用', '交叉验证', '独立复核', '查错通道选型'],
  'titan-defect-census': ['缺陷普查', 'defect census', '全仓体检', '缺陷清单'],
};

function parseAgentsTable(agentsPath) {
  const text = readFileSync(agentsPath, 'utf8');
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|\s*`([a-z0-9-]+)`\s*\|\s*([^|]+?)\s*\|\s*$/);
    if (m) {
      rows.push({
        group: m[1].trim(),
        name: m[2].trim(),
        when: m[3].trim(),
      });
    }
  }
  return rows;
}

function extractTriggers(whenText) {
  const triggers = [];
  // 1. 显式 "触发词：" 模式
  let match = whenText.match(/触发词[:：]\s*([^。]+)/);
  if (match) {
    const parts = match[1].split(/[/\/、，,]/);
    for (const p of parts) {
      const t = p.trim();
      if (t) triggers.push(t);
    }
  }
  // 2. 常见动作词模式：动词/名词 + 空格/分隔
  const actionPatterns = [
    /(评审|复查|盘问|诊断|画图|解析|挖掘|并行|交接|回滚|快照|发布|清理|重构|测试|回测|量化|诊断|调试)[\s/\/、，,]/g,
  ];
  // 3. 英文触发词
  const enPatterns = [/(review|debug|refactor|test|deploy|analyze|diagram|parse|mine|parallel|handoff|rollback|snapshot|publish|cleanup|quant|diagnose|trigger)/gi];
  for (const re of actionPatterns) {
    let m;
    while ((m = re.exec(whenText)) !== null) {
      const t = m[1].trim();
      if (t && !triggers.includes(t)) triggers.push(t);
    }
  }
  for (const re of enPatterns) {
    let m;
    while ((m = re.exec(whenText)) !== null) {
      const t = m[1].trim().toLowerCase();
      if (t && !triggers.includes(t)) triggers.push(t);
    }
  }
  return triggers;
}

function extractAllTriggers(name, whenText) {
  const triggers = extractTriggers(whenText);
  // 补全显式映射
  if (EXPLICIT_TRIGGERS[name]) {
    for (const t of EXPLICIT_TRIGGERS[name]) {
      if (!triggers.includes(t)) triggers.push(t);
    }
  }
  return triggers.slice(0, 8); // 限制数量
}

function extractKeywords(whenText) {
  const keywords = [];
  const clean = whenText.replace(/[。，、；：:;]/g, ' ').replace(/[()（）【】]/g, ' ');
  const words = clean.split(/\s+/).filter(w => w.length > 1);
  for (const w of words) {
    if (!keywords.includes(w)) keywords.push(w);
  }
  return keywords.slice(0, 12);
}

// 构建 registry.json
export function buildRegistry({ skillsRoot = DEFAULT_SKILLS_ROOT, agentsPath = join(REPO_ROOT, 'AGENTS.md') } = {}) {
  const skills = buildManifest({ skillsRoot }).skills;
  const agentsRows = parseAgentsTable(agentsPath);
  const agentsMap = new Map(agentsRows.map(r => [r.name, r]));

  const registrySkills = skills.map(s => {
    const agent = agentsMap.get(s.name);
    const category = agent ? (GROUP_TO_CATEGORY[agent.group] || 'general') : 'general';
    const triggers = agent ? extractAllTriggers(s.name, agent.when) : (EXPLICIT_TRIGGERS[s.name] || []);
    const keywords = agent ? extractKeywords(agent.when) : [];
    const alwaysAttach = s.name === 'titan-quant-tool-discipline';

    return {
      name: s.name,
      category,
      description: s.description,
      triggers,
      keywords,
      alwaysAttach,
      payload: 'SKILL.md',
    };
  });

  return {
    schemaVersion: 1,
    maxMatches: 3,
    maxFullPayloads: 3,
    skills: registrySkills,
  };
}

// 构建 categories.json
export function buildCategories({ skillsRoot = DEFAULT_SKILLS_ROOT, agentsPath = join(REPO_ROOT, 'AGENTS.md') } = {}) {
  const registry = buildRegistry({ skillsRoot, agentsPath });
  const categories = {};

  for (const skill of registry.skills) {
    if (!categories[skill.category]) {
      const label = skill.category
        .split('-')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      categories[skill.category] = {
        label,
        terms: [],
        skills: [],
      };
    }
    categories[skill.category].skills.push(skill.name);
    for (const t of skill.triggers) {
      if (!categories[skill.category].terms.includes(t)) {
        categories[skill.category].terms.push(t);
      }
    }
    for (const k of skill.keywords) {
      if (!categories[skill.category].terms.includes(k)) {
        categories[skill.category].terms.push(k);
      }
    }
  }

  return {
    schemaVersion: 1,
    categories,
  };
}

// 写入 registry.json
export function applyRegistry({
  registryPath = DEFAULT_REGISTRY_PATH,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  agentsPath = join(REPO_ROOT, 'AGENTS.md'),
} = {}) {
  const current = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : '';
  const currentHash = sha256OfText(current);
  const registry = buildRegistry({ skillsRoot, agentsPath });

  const result = withLockedJsonWrite(registryPath, {
    baseSnapshot: currentHash,
    lockPath: registryPath + '.write.lock',
    produceDoc: () => registry,
  });
  if (result.ok) {
    return { ok: true, status: 'written', path: registryPath, revision: sha256OfText(readFileSync(registryPath, 'utf8')) };
  }
  return { ...result, path: registryPath };
}

// 写入 categories.json
export function applyCategories({
  categoriesPath = DEFAULT_CATEGORIES_PATH,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  agentsPath = join(REPO_ROOT, 'AGENTS.md'),
} = {}) {
  const current = existsSync(categoriesPath) ? readFileSync(categoriesPath, 'utf8') : '';
  const currentHash = sha256OfText(current);
  const categories = buildCategories({ skillsRoot, agentsPath });

  const result = withLockedJsonWrite(categoriesPath, {
    baseSnapshot: currentHash,
    lockPath: categoriesPath + '.write.lock',
    produceDoc: () => categories,
  });
  if (result.ok) {
    return { ok: true, status: 'written', path: categoriesPath, revision: sha256OfText(readFileSync(categoriesPath, 'utf8')) };
  }
  return { ...result, path: categoriesPath };
}

// 校验 registry 与磁盘一致
export function verifyRegistry({
  registryPath = DEFAULT_REGISTRY_PATH,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  agentsPath = join(REPO_ROOT, 'AGENTS.md'),
} = {}) {
  if (!existsSync(registryPath)) return { ok: false, issues: ['registry 不存在: ' + registryPath] };
  try {
    const disk = JSON.parse(readFileSync(registryPath, 'utf8'));
    const expected = buildRegistry({ skillsRoot, agentsPath });
    const issues = [];
    if (disk.schemaVersion !== 1) issues.push('registry schemaVersion 不匹配');
    if (disk.maxMatches !== 3) issues.push('registry maxMatches 应为 3');
    if (disk.maxFullPayloads !== 3) issues.push('registry maxFullPayloads 应为 3');
    if (!Array.isArray(disk.skills)) issues.push('registry.skills 必须是数组');
    else {
      const diskNames = new Set(disk.skills.map(s => s.name));
      const expectedNames = new Set(expected.skills.map(s => s.name));
      for (const n of expectedNames) if (!diskNames.has(n)) issues.push('registry 缺失技能: ' + n);
      for (const n of diskNames) if (!expectedNames.has(n)) issues.push('registry 多余技能: ' + n);
    }
    return { ok: issues.length === 0, issues };
  } catch (e) {
    return { ok: false, issues: ['registry 解析失败: ' + e.message] };
  }
}

// 校验 categories 与磁盘一致
export function verifyCategories({
  categoriesPath = DEFAULT_CATEGORIES_PATH,
  skillsRoot = DEFAULT_SKILLS_ROOT,
  agentsPath = join(REPO_ROOT, 'AGENTS.md'),
} = {}) {
  if (!existsSync(categoriesPath)) return { ok: false, issues: ['categories 不存在: ' + categoriesPath] };
  try {
    const disk = JSON.parse(readFileSync(categoriesPath, 'utf8'));
    const expected = buildCategories({ skillsRoot, agentsPath });
    const issues = [];
    if (disk.schemaVersion !== 1) issues.push('categories schemaVersion 不匹配');
    if (!disk.categories || typeof disk.categories !== 'object') issues.push('categories.categories 必须是对象');
    else {
      for (const [cat, data] of Object.entries(expected.categories)) {
        if (!disk.categories[cat]) {
          issues.push('categories 缺失分类: ' + cat);
        } else {
          const expectedSkills = new Set(data.skills.sort());
          const diskSkills = new Set((disk.categories[cat].skills || []).sort());
          for (const s of expectedSkills) if (!diskSkills.has(s)) issues.push(cat + ' 缺失技能: ' + s);
        }
      }
      for (const cat of Object.keys(disk.categories)) {
        if (!expected.categories[cat]) issues.push('categories 多余分类: ' + cat);
      }
    }
    return { ok: issues.length === 0, issues };
  } catch (e) {
    return { ok: false, issues: ['categories 解析失败: ' + e.message] };
  }
}

export default {
  MANIFEST_SCHEMA_VERSION, DEFAULT_SKILLS_ROOT, DEFAULT_MANIFEST_PATH,
  DEFAULT_REGISTRY_PATH, DEFAULT_CATEGORIES_PATH,
  listSkillFiles, parseProvenance, buildSkillEntry, buildManifest, compareManifest,
  readManifest, applyManifest, verifyManifest,
  parseAgentsTable, buildRegistry, buildCategories,
  applyRegistry, applyCategories, verifyRegistry, verifyCategories,
};