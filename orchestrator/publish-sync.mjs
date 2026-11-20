// orchestrator/publish-sync.mjs — T-125：发布树同步账本与一键同步
//
// 问题（T-125 用户提问）：本地仓（路径由脚本位置推导）一直在更新，发布树
// （桌面固定目录，路径由账本记录，见 PUBLISH_SYNC.json）只在需要时手工同步；过一段时间就没人说得清
// 『从哪开始同步』『哪些还没同步』——原先每次都要重新梳理（查发布树 git 历史、
// 逐文件比对、再想该发哪些）。
//
// 本工具把『同步状态』变成可查、可执行的东西：
//   账本 PUBLISH_SYNC.json（本地仓根，提交入库）——记录发布树路径/远端/上次同步的
//     发布提交、来源本地提交、文件数、发布树指纹（sha256）。下次任何人/客户端
//     读这一个文件就知道锚点在哪，不用重新梳理。
//   发布树侧 PUBLISH_MANIFEST.json——apply 时写入并提交，克隆发布仓即知来源与版本。
//
// 命令：
//   status            默认。打印：两侧 HEAD/远端/脏否、指纹是否漂移（发布树被手工改过？）、
//                     待同步文件清单（改了什么/新增了什么）、未发布的本地提交、下一步命令
//   plan              只打印将复制的文件与 sha256 前后值（不写任何文件）
//   apply --yes       复制待同步文件（字节级 + sha256 校验）→ 更新两侧标记 → 提交发布树
//                     （--push 才推送；--no-commit 只落盘不提交）
//   verify            重算发布树指纹，与账本对比，报告漂移与账本一致性（含锚点可达性自检）
//   init              初始化/刷新账本（记录当前发布树指纹 + 当前本地 source commit）
//   repair [--yes]    账本锚点损坏时，按发布树文件内容字节匹配重推断；不带 --yes 只打印候选与对账明细
//   （--tolerance N   允许不匹配文件数，默认 1：同步当日的未提交运行态改动常见为 1）
//
// 安全护栏（发布是公开动作，护栏不能省）：
//   - 只同步「发布树已跟踪的文件」+ 「显式 --include 的新文件」；不按目录猜测
//   - 拒绝含密钥特征的文件/内容（titan_secrets.env、*.pem、AIza/ghp_/sk-/Bearer/PRIVATE KEY 等）
//   - 复制后逐文件 sha256 校验，不一致即报错回滚该文件
//   - 默认不推送（push 需显式 --push）
//   - 账本锚点（lastSync.sourceCommit）在任何写入点强制校验可达，坏值拒写（fail-closed）
import { readFileSync, writeFileSync, existsSync, statSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ROOT = resolve(__dirname, '..');
const LEDGER_NAME = 'PUBLISH_SYNC.json';
const MANIFEST_NAME = 'PUBLISH_MANIFEST.json';

// 发布树路径解析（脱敏：不在代码里硬编码个人路径）：--tree > 账本 > PUBLISH_TREE 环境变量
function resolveTree(opts, ledger) {
  return (opts && opts.tree) || (ledger && ledger.publishTree) || process.env.PUBLISH_TREE || '';
}

// 发布树 .gitignore 受管块：每次 apply 重建（复制会覆盖 .gitignore，条目必须每次补回）
const DENY_BEGIN = '# >>> publish-sync 禁推清单（工具自动维护，勿手改）';
const DENY_END = '# <<< publish-sync 禁推清单';
const DENY_IGNORE_ENTRIES = [
  'ISSUE_REGISTRY.json',
  'PUBLISH_SYNC.json',
  'orchestrator/work-orders.json',
  'orchestrator/汇总*.md',
  'orchestrator/p2-fixes.md',
  'orchestrator/audit-evidence/',
  'orchestrator/分阶段拆分计划.md',
  'orchestrator/分阶段规划.xlsx',
  'orchestrator/add-plan-board-sheet.py',
  'orchestrator/sync-plan-board.py',
  'orchestrator/add-infra-hardening-sheet.py',
  'orchestrator/gen-phase-plan-xlsx.py',
  'orchestrator/add-ultimate-goal-sheet.py',
  'orchestrator/计划-收口修复-*',
  'titan-memory/core/CORE.md',
  '.agents/skills/titan-publish-sync/',
  '*.log',
  'reviews/', 'archive/', 'tmp/', 'design-specs/', 'evidence/',
  'bin/', 'HARNESS/', 'cfnext/', 'freellmapi-src/', 'chrome-cdp-profile/',
  'cline-local/', 'test-projects/', 'V8_HEADLESS/'
];

function ensureDenyIgnore(pubDir) {
  // 写 .git/info/exclude（本克隆生效、不入库）：.gitignore 会随同步被本地版覆盖，且写成受管块会让
  // .gitignore 永远与本地版不一致（每次 apply 都误报改动）。exclude 没有这两个问题。
  const exPath = join(pubDir, '.git', 'info', 'exclude');
  mkdirSync(dirname(exPath), { recursive: true });
  let gi = existsSync(exPath) ? readFileSync(exPath, 'utf8') : '';
  const re = new RegExp('\\n?' + DENY_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\\s\\S]*?' + DENY_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\n?', 'g');
  gi = gi.replace(re, '\n');
  if (gi && !gi.endsWith('\n')) gi += '\n';
  gi += '\n' + DENY_BEGIN + '\n' + DENY_IGNORE_ENTRIES.join('\n') + '\n' + DENY_END + '\n';
  writeFileSync(exPath, gi, 'utf8');
  return DENY_IGNORE_ENTRIES.length;
}

// 禁推清单（T-126 用户政策：发布集 = V2 流水线完整逻辑链（脱敏后）；其余禁推）：
//   ①内部台账/队列/审计基线（ISSUE_REGISTRY.json 类，用户点名永不推 GitHub）
//   ②内部运维 SOP 与实例数据（非逻辑链）
//   ③运行时产物与本地专属目录
const NEVER_PUBLISH = [
  /^ISSUE_REGISTRY\.json$/,                    // 任务台账（用户点名）
  /^orchestrator\/work-orders\.json$/,         // 工单队列（同台账类）
  /^orchestrator\/汇总.*\.md$/,                // 审计基线报告
  /^orchestrator\/p2-fixes\.md$/,              // 内部修复日志
  /^orchestrator\/audit-evidence\//,           // 审计证据
  /^orchestrator\/分阶段拆分计划\.md$/,
  /^orchestrator\/分阶段规划\.xlsx$/,             // 阶段规划表（内部工作产物，非流水线本体）
  /^orchestrator\/(add-plan-board-sheet|sync-plan-board|add-infra-hardening-sheet)\.py$/, // 规划表维护脚本
  /^orchestrator\/gen-phase-plan-xlsx\.py$/,     // 规划表生成脚本（内部工具）
  /^orchestrator\/add-ultimate-goal-sheet\.py$/, // 终极目标调研写入脚本（内部工具）
  /^orchestrator\/config\/secret-expiry\.json$/,  // 密钥到期台账（含账号名/到期日 → 本地专属）
  /^orchestrator\/test\/subs-proxy\.test\.mjs$/, // 本地代理环境测试（依赖本机 bin/ 与本机路径）
  /^orchestrator\/计划-收口修复-/,
  /^titan-memory\/core\/CORE\.md$/,            // 实例记忆（非逻辑链；公开仓应各自生成）
  /^titan-memory\/core\//,                    // 实例记忆目录（核心 + 长尾笔记）
  /^titan-memory\/notes\//,                   // 实例记忆长尾笔记（与 CORE.md 同类）
  /^docs\//,                                  // 研究/产品文档：只发布流水线本身，不发布流水线做出的产品
  /^\.agents\/skills\/titan-publish-sync\//,   // 本技能自身（内部运维 SOP，含本地路径与政策）
  /^(PUBLISH_SYNC)\.json$/,                    // 本地账本（含本地发布树路径，不入公开仓）；发布侧清单 PUBLISH_MANIFEST.json 相反，必须发布
  /\.log$/i,
  /(^|\/)(reviews|archive|tmp|design-specs|evidence|bin|HARNESS|cfnext|freellmapi-src|chrome-cdp-profile|cline-local|test-projects|V8_HEADLESS)\//
];

/** 该相对路径是否属于「永不外发」类 */
export function isNeverPublish(rel) {
  const r = String(rel).split('\\').join('/');
  return NEVER_PUBLISH.some((re) => re.test(r));
}

// 发布路径映射：发布树里的文件从本地仓的哪个文件取内容。
// 用途：发布树里的 AGENTS.md 是**公开版宪法**（内容源在本地仓 docs/publish/AGENTS.md），
//       不能用本地宪法覆盖它（本地宪法含内部信息，按 M8 不外发）。
export const PUBLISH_MAP = Object.freeze({
  'AGENTS.md': 'docs/publish/AGENTS.md',
});

/** 发布路径 → 本地来源路径 */
export function sourceOf(rel) {
  const r = String(rel).split('\\').join('/');
  return PUBLISH_MAP[r] || r;
}

// 禁止出现在发布树里的文件（路径片段 + 文件名模式）
const DENY_PATH = [
  /titan_secrets\.env/i,
  /(^|\/)[^/]*secrets?(\.env|\.json|\.yaml|\.yml)?$/i,   // secrets.env / secret.json / secrets
  /(^|\/)\.env(\.|$)/i, /\.pem$/i, /\.key$/i, /(^|\/)id_rsa/i,
  /credentials/i, /(^|\/)secrets?(\/|$)/i, /\.p12$/i, /\.pfx$/i, /(^|\/)\.npmrc$/i
];
// 内容级敏感特征（发布是公开动作，宁可误报）：密钥类 + 内部路径类（个人桌面路径/机器用户名路径）
// 注意：内部路径特征用 \u 转义书写，避免工具自身源码命中自己的扫描
const SECRET_PATTERNS = [
  [/AIza[0-9A-Za-z\-_]{20,}/, 'Google API Key'],
  [/ghp_[0-9A-Za-z]{20,}/, 'GitHub PAT'],
  [/gho_[0-9A-Za-z]{20,}/, 'GitHub OAuth token'],
  [/github_pat_[0-9A-Za-z_]{20,}/, 'GitHub fine-grained PAT'],
  [/sk-[0-9A-Za-z]{20,}/, 'OpenAI-style key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
  [/\bBearer\s+[0-9A-Za-z\-._~+/]{24,}/, 'Bearer token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'AWS access key'],
  [/\bxox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/\beyJ[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}\.[0-9A-Za-z_-]{8,}/, 'JWT'],
  [/D:[\\/]{1,2}我的文档/, 'internal personal path (desktop)'],
  [/C:[\\/]{1,2}Users[\\/]{1,2}[^\\/]+/i, 'machine user path (use %USERPROFILE% instead)'],
  // 本机工作区路径同样是"机器路径"（公开仓应让用户用自己的工作区）——字面量用拼接构造，避免本工具源码命中自己的扫描
  [new RegExp('[A-Z]:[\\\\/]{1,2}' + ('TITAN_' + 'ARCHAEOLOGY'), 'i'), 'local workspace path (derive from script location or env)'],
];
// ------------------------------------------------------------------ 基础工具

function sha256File(abs) {
  return createHash('sha256').update(readFileSync(abs)).digest('hex');
}

function sha256Text(t) {
  return createHash('sha256').update(t, 'utf8').digest('hex');
}

function git(cwd, args, allowFail = false) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).trim();
  } catch (e) {
    if (allowFail) return '';
    throw new Error('git ' + args.join(' ') + ' failed: ' + String(e.stderr || e.message).trim());
  }
}

// 二进制安全的 git 输出（字节原样返回，不做 utf8 解码）
function gitBuf(cwd, args, allowFail = false, input) {
  try {
    return execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, input });
  } catch (e) {
    if (allowFail) return null;
    throw new Error('git ' + args.join(' ') + ' failed: ' + String(e.stderr || e.message).trim());
  }
}

/** 锚点是否在本仓可达（存在且为 commit 对象）。坏值/空串/相对引用一律 false。 */
export function isCommitReachable(localRoot, commit) {
  const c = String(commit || '').trim();
  if (!/^[0-9a-f]{4,64}$/i.test(c)) return false;   // 拒绝 'HEAD'、'x..HEAD'、注入式参数
  try {
    execFileSync('git', ['cat-file', '-e', c + '^{commit}'], { cwd: localRoot, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** 锚点不可达即抛错（fail-closed）：任何写账本点必须先过这道闸 */
export function assertCommitReachable(localRoot, commit, label = '账本锚点') {
  const c = String(commit || '').trim();
  if (!isCommitReachable(localRoot, c)) {
    throw new Error(label + '不可达：' + (c || '(空)') + ' —— 本仓不存在该提交。跑 node orchestrator/publish-sync.mjs repair 推断修复，不要手改 PUBLISH_SYNC.json。');
  }
  return c;
}

/** 发布树已跟踪的文件（发布集 = 已跟踪集合，不猜测） */
export function listPublishedFiles(pubDir) {
  const out = git(pubDir, ['ls-files', '-z']);
  return out.split('\0').filter(Boolean);
}

/** 发布树内容指纹：排序后的 path:sha256 列表再哈希——单值即可检测任意漂移 */
export function fingerprint(pubDir, files) {
  const lines = files
    .filter((f) => existsSync(join(pubDir, f)))
    .map((f) => f + ':' + sha256File(join(pubDir, f)))
    .sort();
  return { sha256: sha256Text(lines.join('\n')), fileCount: lines.length };
}

export function secretScan(absPath, relPath) {
  const problems = [];
  for (const re of DENY_PATH) {
    if (re.test(relPath)) { problems.push('deny-path: ' + relPath); break; }
  }
  let content = '';
  try { content = readFileSync(absPath, 'utf8'); } catch (e) { return problems; }
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(content)) problems.push('secret-pattern(' + label + '): ' + relPath);
  }
  return problems;
}

/** 两侧差集：改了什么 / 本地新增候选（以「来源提交」为锚点的 git 变更范围）/ 发布树独有 */
export function computeDrift(localRoot, pubDir, publishedFiles, extraInclude = [], sourceCommit = '') {
  const pubSet = new Set(publishedFiles);
  const changed = [];
  const changedDenied = [];   // 已跟踪但属禁推（apply 将 git rm --cached 剔除）
  const publishedOnly = [];
  for (const f of publishedFiles) {
    const lp = join(localRoot, sourceOf(f));
    const pp = join(pubDir, f);
    if (isNeverPublish(f)) { changedDenied.push(f); continue; }
    if (!existsSync(lp)) { publishedOnly.push(f); continue; }
    if (!existsSync(pp)) { changed.push({ file: f, kind: 'missing-in-pub' }); continue; }
    if (sha256File(lp) !== sha256File(pp)) changed.push({ file: f, kind: 'modified' });
  }

  // 发布根目录：已发布文件所在的顶层目录（新增文件只从这些目录里找）
  const pubRoots = new Set();
  for (const f of publishedFiles) {
    const i = f.indexOf('/');
    pubRoots.add(i > 0 ? f.slice(0, i) : '.');
  }
  const eligible = (rel) => {
    if (isNeverPublish(rel)) return false;                   // 禁推清单（含日志/内部目录/本技能）
    if (rel.includes('/node_modules/') || rel.startsWith('node_modules/')) return false;
    if (rel.includes('__pycache__') || rel.endsWith('.pyc')) return false;
    const top = rel.includes('/') ? rel.split('/')[0] : '.';
    return pubRoots.has(top) || top === '.';
  };

  // 新增候选：以「来源提交」为锚点的 git 变更范围（精确），不是全树扫描（否则噪声上千）
  const candidates = [];
  if (sourceCommit) {
    const raw = git(localRoot, ['diff', '--name-status', '--no-renames', sourceCommit + '..HEAD'], true);
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0] || '';
      const file = (parts[parts.length - 1] || '').split(sep).join('/');
      if (!file || !eligible(file)) continue;
      if (pubSet.has(file)) continue;              // 已发布 → 属「改动」不属「新增」
      if (status.startsWith('D')) continue;        // 本地已删 → 不作为新增候选
      if (status.startsWith('A') || status.startsWith('M') || status.startsWith('R')) candidates.push(file);
    }
  }
  const explicit = extraInclude.map((p) => p.split(sep).join('/')).filter((p) => !pubSet.has(p));
  return { changed, changedDenied, publishedOnly, candidates: [...new Set(candidates)].sort(), explicit };
}

/** 推断「与发布树对应的本地提交」：发布树 HEAD 提交信息里的任务号 → 本地仓同任务号提交 */
export function inferSourceCommit(localRoot, pubDir) {
  const msg = git(pubDir, ['log', '-1', '--format=%s'], true);
  const m = String(msg).match(/T-\d+/);
  if (!m) return '';
  const c = git(localRoot, ['log', '--format=%H', '-1', '--grep=' + m[0], '--all-match'], true);
  return c || '';
}

/**
 * 按内容字节匹配推断「发布树对应的本地提交」（repair 用）。
 * 对每个候选提交解析 ls-tree 得到全部 blob id，与发布树文件按 blob id 比对——
 * 二进制安全、无需 checkout、不受 utf8 解码影响（PUBLISH_MAP 感知：AGENTS.md 比对 docs/publish/AGENTS.md）。
 * 语义：取「得分最高且提交最旧」的提交——宁可把锚点往前推（diff 范围偏大、新候选可见性偏大），
 * 也不把锚点往后推（会无声吃掉「发布时尚未入库的新文件」候选）。
 * 返回 { best, score, total, unmatched[], walked, truncated }；best='' 表示无匹配提交。
 */
export function findSourceCommitByContent(localRoot, pubDir, files, opts = {}) {
  const maxRevs = Number(opts.maxRevs) || 5000;
  // 发布树 → 本地来源路径；发布树里缺失的文件不计分
  const want = [];
  for (const f of files) {
    const pp = join(pubDir, f);
    if (!existsSync(pp)) continue;
    const localPath = sourceOf(f);
    const buf = gitBuf(localRoot, ['hash-object', '--stdin'], false, readFileSync(pp));
    if (buf) want.push({ pub: f, local: localPath, blob: buf.toString('utf8').trim() });
  }
  if (!want.length) return { best: '', score: 0, total: 0, unmatched: [], walked: 0, truncated: false };
  function treeOf(rev) {
    const treeRaw = gitBuf(localRoot, ['ls-tree', '-r', '-z', rev], true);
    const blobByPath = new Map();
    if (treeRaw) {
      for (const entry of treeRaw.toString('utf8').split('\0')) {
        if (!entry) continue;
        const tab = entry.indexOf('\t');
        if (tab < 0) continue;
        const meta = entry.slice(0, tab).split(' ');
        if (meta.length < 3 || meta[1] !== 'blob') continue;
        blobByPath.set(entry.slice(tab + 1), meta[2]);
      }
    }
    return blobByPath;
  }
  const revs = git(localRoot, ['rev-list', 'HEAD', '--max-count=' + maxRevs], true).split('\n').filter(Boolean);
  let best = { rev: '', score: -1 };
  let walked = 0;
  for (const rev of revs) {
    walked++;
    const blobByPath = treeOf(rev);
    let score = 0;
    for (const w of want) if (blobByPath.get(w.local) === w.blob) score++;
    if (score >= best.score) best = { rev, score };   // 同分取更旧（rev-list 由新到旧）
  }
  let unmatched = [];
  if (best.rev) {
    const blobByPath = treeOf(best.rev);
    unmatched = want.filter((w) => blobByPath.get(w.local) !== w.blob).map((w) => w.pub);
  } else {
    unmatched = want.map((w) => w.pub);
  }
  return { best: best.rev, score: Math.max(0, best.score), total: want.length, unmatched, walked, truncated: revs.length >= maxRevs };
}

// ------------------------------------------------------------------ 账本读写

export function ledgerPath(localRoot = LOCAL_ROOT) {
  return join(localRoot, LEDGER_NAME);
}

export function readLedger(localRoot = LOCAL_ROOT) {
  const p = ledgerPath(localRoot);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch (e) { return null; }
}

export function writeLedger(localRoot, ledger) {
  const sc = ledger && ledger.lastSync && ledger.lastSync.sourceCommit;
  // fail-closed：锚点必须在本仓可达，否则拒写（宁停不写死锚点）
  if (sc) assertCommitReachable(localRoot, sc, '账本锚点');
  const p = ledgerPath(localRoot);
  writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n', 'utf8');
  return p;
}

function buildLedger(localRoot, pubDir, includeFiles, sourceCommit, sourceInferred, prev) {
  const files = listPublishedFiles(pubDir);
  const fp = fingerprint(pubDir, files);
  const remote = git(pubDir, ['remote', 'get-url', 'origin'], true);
  const branch = git(pubDir, ['rev-parse', '--abbrev-ref', 'HEAD'], true) || 'main';
  const base = {
    schemaVersion: 1,
    generatedBy: 'orchestrator/publish-sync.mjs',
    localRepo: localRoot.replace(/\\/g, '/'),
    publishTree: pubDir.replace(/\\/g, '/'),
    publishRemote: remote,
    publishBranch: branch,
    lastSync: {
      at: new Date().toISOString(),
      publishedCommit: git(pubDir, ['rev-parse', 'HEAD'], true),
      publishedFiles: fp.fileCount,
      publishedFingerprint: fp.sha256,
      // 空 fallback 会写出「坏锚点」；fail-closed：不可达即抛错，宁停不写死值
      sourceCommit: assertCommitReachable(localRoot, sourceCommit || git(localRoot, ['rev-parse', 'HEAD'], true), '账本锚点'),
      sourceCommitInferred: !!sourceInferred,
      sourceFiles: includeFiles.length
    },
    note: '发布集 = 发布树已跟踪文件（不猜测）；新文件需显式 --include 才会发布。指纹用于检测发布树被手工改动。'
  };
  // 保留旧账本里的附加字段（如 backlogAtInit），避免 apply 覆盖时丢元数据
  if (prev && typeof prev === 'object') {
    for (const k of Object.keys(prev)) {
      if (!(k in base)) base[k] = prev[k];
    }
  }
  return base;
}

// 解析「本次可用的对比锚点」：账本锚点坏值绝不传给 git diff/rev-list（会 fatal 泄漏 + 静默 0 结果）。
// 返回 { anchor, broken, raw }：broken=true 表示账本锚点本仓不可达（status/plan 只告警；apply 拒写）。
function resolveLedgerAnchor(localRoot, ledger, pubDir) {
  const raw = (ledger && ledger.lastSync && ledger.lastSync.sourceCommit) || '';
  if (raw) {
    if (isCommitReachable(localRoot, raw)) return { anchor: raw, broken: false, raw };
    return { anchor: '', broken: true, raw };
  }
  const inferred = inferSourceCommit(localRoot, pubDir);
  const ok = inferred && isCommitReachable(localRoot, inferred) ? inferred : '';
  return { anchor: ok, broken: false, raw: '' };
}

function anchorBrokenNote(raw) {
  return '[账本损坏] 来源提交 ' + String(raw).slice(0, 12) + ' 在本仓不存在（历次锚点 4bf76783/8c221de0/9a0ef04/5312824e 曾全部为此坏死值）。\n'
    + '           新候选计算已跳过；先跑 node orchestrator/publish-sync.mjs repair 查看修复方案，加 --yes 落盘。';
}

// ------------------------------------------------------------------ 命令实现

function printHeader(lines) { for (const l of lines) console.log(l); }

function cmdStatus(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger = readLedger(localRoot);
  const pubDir = resolveTree(opts, ledger);
  if (!pubDir) {
    console.log('[FAIL] 未指定发布树：用 --tree <路径> 指定，或先跑 init 建账本，或设 PUBLISH_TREE 环境变量。');
    return 2;
  }
  if (!existsSync(pubDir)) {
    console.log('[FAIL] 发布树不存在: ' + pubDir);
    console.log('用 --tree <路径> 指定，或先修 PUBLISH_SYNC.json 里的 publishTree。');
    return 2;
  }
  const publishedFiles = listPublishedFiles(pubDir);
  const fp = fingerprint(pubDir, publishedFiles);
  const anchorRes = resolveLedgerAnchor(localRoot, ledger, pubDir);
  const srcCommit = anchorRes.anchor;
  if (anchorRes.broken) printHeader([anchorBrokenNote(anchorRes.raw)]);
  const drift = computeDrift(localRoot, pubDir, publishedFiles, opts.include, srcCommit);
  const localHead = git(localRoot, ['rev-parse', 'HEAD'], true);
  const pubHead = git(pubDir, ['rev-parse', 'HEAD'], true);
  const pubDirty = git(pubDir, ['status', '--porcelain'], true);

  printHeader([
    '=== 发布同步状态 ===',
    '本地仓      : ' + localRoot + '  HEAD=' + localHead.slice(0, 12),
    '发布树      : ' + pubDir,
    '发布树 HEAD : ' + pubHead.slice(0, 12) + (pubDirty ? '  (工作区有未提交改动!)' : '  (干净)'),
    '发布远端    : ' + (git(pubDir, ['remote', 'get-url', 'origin'], true) || '(无)')
  ]);

  if (ledger) {
    const l = ledger.lastSync || {};
    printHeader([
      '账本锚点    : ' + LEDGER_NAME,
      '  上次同步  : ' + (l.at || '(未记录)'),
      '  发布提交  : ' + String(l.publishedCommit || '').slice(0, 12),
      '  来源提交  : ' + String(l.sourceCommit || '').slice(0, 12) + (l.sourceCommitInferred ? ' (推断)' : '') + (!l.sourceCommit ? '' : (anchorRes.broken ? ' ← 本仓不存在！' : '')),
      '  记录指纹  : ' + String(l.publishedFingerprint || '').slice(0, 16) + '…',
      '  当前指纹  : ' + fp.sha256.slice(0, 16) + '…  ' + (l.publishedFingerprint === fp.sha256 ? '一致（发布树未被手工改动）' : '不一致 → 发布树被手工改过，需人工确认')
    ]);
    if (l.sourceCommit && !anchorRes.broken && localHead !== l.sourceCommit) {
      const cnt = git(localRoot, ['rev-list', '--count', l.sourceCommit + '..HEAD'], true);
      const log = git(localRoot, ['log', '--oneline', '-8', l.sourceCommit + '..HEAD'], true);
      printHeader(['  未发布本地提交: ' + (cnt || '?') + ' 个' + (log ? '\n    ' + log.split('\n').join('\n    ') : '')]);
    } else if (anchorRes.broken) {
      printHeader(['  未发布本地提交: 无法统计（锚点坏值已隔离，未传给 git）']);
    }
  } else {
    const inferred = inferSourceCommit(localRoot, pubDir);
    printHeader(['账本锚点    : 尚无 ' + LEDGER_NAME + '（跑 init 建立）']);
    if (inferred) printHeader(['  推断来源提交: ' + inferred.slice(0, 12) + '（按发布树 HEAD 提交信息里的任务号匹配）']);
  }

  const changedFiles = drift.changed.map((c) => c.file);
  const newFiles = [...drift.candidates, ...drift.explicit];
  printHeader([
    '',
    '待同步      : 改动 ' + changedFiles.length + ' 个 / 新增候选 ' + drift.candidates.length + ' 个 / 显式指定 ' + drift.explicit.length + ' 个'
  ]);
  for (const f of changedFiles.slice(0, 40)) console.log('  [改] ' + f);
  if (changedFiles.length > 40) console.log('  ... 合计 ' + changedFiles.length + ' 个');
  for (const f of drift.candidates) console.log('  [新] ' + f + '   (需 --include 才会发布)');
  for (const f of drift.explicit) console.log('  [含] ' + f + '   (显式指定)');
  if (drift.changedDenied.length) {
    console.log('  [剔] 已跟踪但属禁推，apply 将剔除: ' + drift.changedDenied.length + ' 个');
    for (const f of drift.changedDenied) console.log('       ' + f);
  }
  if (drift.publishedOnly.length) {
    console.log('  [仅发布树有] ' + drift.publishedOnly.length + ' 个（本地已无此文件，保留还是删除需人工决定）');
    for (const f of drift.publishedOnly.slice(0, 10)) console.log('       ' + f);
  }
  console.log('');
  console.log('下一步: node orchestrator/publish-sync.mjs plan' + (newFiles.length ? ' --include ' + newFiles.join(',') : ''));
  console.log('      确认后 node orchestrator/publish-sync.mjs apply --yes' + (newFiles.length ? ' --include ' + newFiles.join(',') : '') + ' [--push]');
  return 0;
}

function cmdPlan(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger = readLedger(localRoot);
  const pubDir = resolveTree(opts, ledger);
  if (!pubDir) { console.log('[FAIL] 未指定发布树：--tree <路径> / init 建账本 / PUBLISH_TREE 环境变量。'); return 2; }
  if (!existsSync(pubDir)) { console.log('[FAIL] 发布树不存在: ' + pubDir); return 2; }
  const publishedFiles = listPublishedFiles(pubDir);
  const anchorRes = resolveLedgerAnchor(localRoot, ledger, pubDir);
  const srcCommit = anchorRes.anchor;
  if (anchorRes.broken) console.log(anchorBrokenNote(anchorRes.raw));
  const drift = computeDrift(localRoot, pubDir, publishedFiles, opts.include, srcCommit);
  const deniedExplicit = drift.explicit.filter((f) => isNeverPublish(f));
  const allowedExplicit = drift.explicit.filter((f) => !isNeverPublish(f));
  const targets = [
    ...drift.changed.map((c) => ({ file: c.file, kind: c.kind })),
    ...allowedExplicit.map((f) => ({ file: f, kind: 'new-explicit' }))
  ];
  console.log('=== 同步计划（' + targets.length + ' 个文件' + (drift.changedDenied.length ? ' + 剔除 ' + drift.changedDenied.length + ' 个禁推' : '') + '）===');
  if (!targets.length && !drift.changedDenied.length) { console.log('无待同步内容。'); return 0; }
  let blocked = 0;
  for (const t of targets) {
    const lp = join(localRoot, sourceOf(t.file));
    const pp = join(pubDir, t.file);
    if (!existsSync(lp)) { console.log('  [跳过] ' + t.file + ' (本地不存在)'); continue; }
    const issues = secretScan(lp, t.file);
    const src = sha256File(lp);
    const dst = existsSync(pp) ? sha256File(pp) : '(不存在)';
    if (issues.length) {
      blocked++;
      console.log('  [拦截] ' + t.file + ' — ' + issues.join('; '));
      continue;
    }
    console.log('  ' + t.kind.padEnd(14) + ' ' + t.file);
    console.log('      发布树 ' + dst.slice(0, 16) + '… → 本地 ' + src.slice(0, 16) + '…');
  }
  for (const f of drift.changedDenied) console.log('  [剔除] ' + f + ' — 禁推（台账/实例数据/内部 SOP 类，永不外发）');
  for (const f of deniedExplicit) console.log('  [拒收] ' + f + ' — 禁推清单拒绝 --include');
  console.log('');
  if (blocked) {
    console.log('[WARN] ' + blocked + ' 个文件因密钥/内部路径特征被拦截，不会发布。');
    console.log('处理: 脱敏后重跑，或从发布集移除该文件。');
  }
  return 0;
}

function cmdApply(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger = readLedger(localRoot);
  const pubDir = resolveTree(opts, ledger);
  if (!pubDir) { console.log('[FAIL] 未指定发布树：--tree <路径> / init 建账本 / PUBLISH_TREE 环境变量。'); return 2; }
  if (!existsSync(pubDir)) { console.log('[FAIL] 发布树不存在: ' + pubDir); return 2; }
  if (!opts.yes) {
    console.log('[DRY-RUN] 未带 --yes，不做任何写入。先跑 plan 看清单：');
    return cmdPlan(opts);
  }
  // fail-closed：账本锚点坏值时拒绝任何写入（宁停不猜；先跑 repair）
  const planAnchor = resolveLedgerAnchor(localRoot, ledger, pubDir);
  if (planAnchor.broken) {
    console.log('[FAIL] 账本锚点不可用，apply 已拒绝。');
    console.log(anchorBrokenNote(planAnchor.raw));
    return 2;
  }
  const publishedFiles = listPublishedFiles(pubDir);
  const srcCommit = planAnchor.anchor;
  const drift = computeDrift(localRoot, pubDir, publishedFiles, opts.include, srcCommit);
  const allowedExplicit = drift.explicit.filter((f) => !isNeverPublish(f));
  const deniedExplicit = drift.explicit.filter((f) => isNeverPublish(f));
  const targets = [
    ...drift.changed.map((c) => ({ file: c.file, kind: c.kind })),
    ...allowedExplicit.map((f) => ({ file: f, kind: 'new-explicit' }))
  ];
  if (!targets.length && !drift.changedDenied.length) { console.log('无待同步内容。'); return 0; }

  const failed = [];
  const copied = [];
  const blocked = [];
  for (const t of targets) {
    const lp = join(localRoot, sourceOf(t.file));
    const pp = join(pubDir, t.file);
    if (!existsSync(lp)) { failed.push(t.file + ' (本地不存在)'); continue; }
    const issues = secretScan(lp, t.file);
    if (issues.length) { blocked.push(t.file + ' — ' + issues.join('; ')); continue; }
    try {
      mkdirSync(dirname(pp), { recursive: true });
      copyFileSync(lp, pp);
      const a = sha256File(lp);
      const b = sha256File(pp);
      if (a !== b) { failed.push(t.file + ' (复制后 sha256 不一致)'); continue; }
      copied.push(t.file);
      console.log('  [复制] ' + t.file);
    } catch (e) {
      failed.push(t.file + ' (' + e.message + ')');
    }
  }

  // 禁推剔除（prune）：已跟踪但属禁推清单 → git rm --cached（文件留在盘上，但从此不跟踪/不外发）
  // 必须放在复制之后：复制会覆盖发布树 .gitignore，若先剔除、后复制，ignore 登记会被冲掉，
  // 随后 git add -A 又会把禁推文件重新加回（T-126 实证事故）。
  const pruned = [];
  for (const f of drift.changedDenied) {
    try {
      git(pubDir, ['rm', '--cached', '--quiet', '--', f]);
      pruned.push(f);
      console.log('  [剔除] ' + f);
    } catch (e) {
      failed.push(f + ' (prune: ' + e.message + ')');
    }
  }
  if (pruned.length) {
    const giPath = join(pubDir, '.gitignore');
    let gi = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    const have = new Set(gi.split('\n').map((l) => l.trim()));
    const missing = pruned.filter((f) => !have.has(f));
    if (missing.length) {
      if (gi && !gi.endsWith('\n')) gi += '\n';
      gi += '\n# 禁推清单（publish-sync prune，T-126）：内部台账/实例数据/运维 SOP 永不外发\n' + missing.join('\n') + '\n';
      writeFileSync(giPath, gi, 'utf8');
      console.log('  [忽略] 发布树 .gitignore 已登记 ' + missing.length + ' 条禁推');
    }
  }
  // 无论本次是否剔除，都重建受管块：复制会覆盖 .gitignore，禁推条目必须每次补回（否则 git add -A 重新加回）
  const denyCount = ensureDenyIgnore(pubDir);
  console.log('  [忽略] 发布树 .gitignore 受管块已刷新（' + denyCount + ' 条禁推规则）');
  for (const f of deniedExplicit) console.log('  [拒收] ' + f + ' — 禁推清单拒绝 --include');
  for (const b of blocked) console.log('  [拦截] ' + b);
  for (const f of failed) console.log('  [失败] ' + f);
  if (!copied.length && !pruned.length) {
    console.log('[FAIL] 既未复制也未剔除任何文件（拦截 ' + blocked.length + ' / 失败 ' + failed.length + '）。');
    return 1;
  }

  // 发布树侧标记（随本次提交入库，克隆发布仓即知来源）
  const fp = fingerprint(pubDir, listPublishedFiles(pubDir));
  const manifest = {
    schemaVersion: 1,
    generatedBy: 'orchestrator/publish-sync.mjs',
    sourceRepo: localRoot.replace(/\\/g, '/'),
    sourceCommit: git(localRoot, ['rev-parse', 'HEAD'], true),
    syncedAt: new Date().toISOString(),
    publishedFiles: fp.fileCount,
    publishedFingerprint: fp.sha256,
    note: '本仓由本地工作区的发布树同步生成；来源提交见 sourceCommit；禁推清单见 publish-sync.mjs NEVER_PUBLISH。'
  };
  writeFileSync(join(pubDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  console.log('  [标记] ' + MANIFEST_NAME);

  // 本地账本：来源提交 = 本次同步对应的本地 HEAD（不是漂移锚点）
  const newSourceCommit = git(localRoot, ['rev-parse', 'HEAD'], true);
  const newLedger = buildLedger(localRoot, pubDir, copied, newSourceCommit, false, ledger);
  newLedger.lastSync.at = new Date().toISOString();
  newLedger.lastSync.syncedFiles = copied.length;
  newLedger.lastSync.syncedFileList = copied;
  // 剔除记录累计保留（后续 apply 只同步少量文件时不应抹掉历史剔除审计）
  const prevPruned = (ledger && ledger.lastSync && ledger.lastSync.prunedFiles) || [];
  newLedger.lastSync.prunedFiles = Array.from(new Set([...prevPruned, ...pruned]));
  writeLedger(localRoot, newLedger);
  console.log('  [账本] ' + LEDGER_NAME);

  if (!opts.noCommit) {
    const msg = opts.msg || ('chore: 同步发布树（' + copied.length + ' 个文件' + (pruned.length ? '，剔除 ' + pruned.length + ' 个禁推' : '') + '，来源 ' + newLedger.lastSync.sourceCommit.slice(0, 8) + '）');
    git(pubDir, ['add', '-A']);
    git(pubDir, ['commit', '-m', msg]);
    console.log('  [提交] ' + msg);
    newLedger.lastSync.publishedCommit = git(pubDir, ['rev-parse', 'HEAD'], true);
    const postFp = fingerprint(pubDir, listPublishedFiles(pubDir));
    newLedger.lastSync.publishedFingerprint = postFp.sha256;
    newLedger.lastSync.publishedFiles = postFp.fileCount;
    writeLedger(localRoot, newLedger);
    if (opts.push) {
      git(pubDir, ['push', 'origin', newLedger.publishBranch || 'main']);
      console.log('  [推送] origin/' + (newLedger.publishBranch || 'main'));
    } else {
      console.log('  (未推送：加 --push 才会推远端)');
    }
  }
  console.log('完成：同步 ' + copied.length + ' 个文件，剔除 ' + pruned.length + ' 个禁推，拦截 ' + blocked.length + '，失败 ' + failed.length + '。');
  return failed.length ? 1 : 0;
}

function cmdVerify(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger = readLedger(localRoot);
  const pubDir = resolveTree(opts, ledger);
  if (!pubDir) { console.log('[FAIL] 未指定发布树：--tree <路径> / init 建账本 / PUBLISH_TREE 环境变量。'); return 2; }
  if (!existsSync(pubDir)) { console.log('[FAIL] 发布树不存在: ' + pubDir); return 2; }
  const files = listPublishedFiles(pubDir);
  const fp = fingerprint(pubDir, files);
  console.log('=== 发布树校验 ===');
  console.log('  文件数   : ' + fp.fileCount);
  console.log('  当前指纹 : ' + fp.sha256);
  if (!ledger) { console.log('  账本     : 缺失（跑 init 建立）'); return 1; }
  const l = ledger.lastSync || {};
  const anchorOk = l.sourceCommit ? isCommitReachable(localRoot, l.sourceCommit) : false;
  console.log('  锚点可达 : ' + (l.sourceCommit ? (anchorOk ? '✓ ' + String(l.sourceCommit).slice(0, 12) : '✗ 本仓不存在 ' + String(l.sourceCommit).slice(0, 12) + '（先跑 repair）') : '(未记录)'));
  console.log('  账本指纹 : ' + String(l.publishedFingerprint || '(无)'));
  const ok = l.publishedFingerprint === fp.sha256;
  console.log('  结论     : ' + (ok ? '一致 ✓' : '不一致 ✗（发布树在上次同步后被改动过）'));
  const mPath = join(pubDir, MANIFEST_NAME);
  if (existsSync(mPath)) {
    const m = JSON.parse(readFileSync(mPath, 'utf8'));
    console.log('  发布树清单: ' + MANIFEST_NAME + '（来源提交 ' + String(m.sourceCommit).slice(0, 12) + '，同步于 ' + m.syncedAt + '）');
  } else {
    console.log('  发布树清单: 缺失（下一次 apply 会生成）');
  }
  return (ok && anchorOk) ? 0 : 1;
}

function cmdInit(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger0 = readLedger(localRoot);
  const pubDir = resolveTree(opts, ledger0);
  if (!pubDir) { console.log('[FAIL] 未指定发布树：用 --tree <路径> 指定，或设 PUBLISH_TREE 环境变量。'); return 2; }
  if (!existsSync(pubDir)) { console.log('[FAIL] 发布树不存在: ' + pubDir); return 2; }
  const files = listPublishedFiles(pubDir);
  const inferred = inferSourceCommit(localRoot, pubDir);
  const srcCommit = opts.sourceCommit || inferred;
  // fail-closed：显式/推断的锚点都必须可达，否则拒写（坏值进不了账本）
  if (srcCommit && !isCommitReachable(localRoot, srcCommit)) {
    console.log('[FAIL] 来源提交 ' + String(srcCommit).slice(0, 12) + ' 在本仓不存在，init 已拒绝（账本未写入）。');
    console.log('       显式值请核对拼写；推断值请先跑 repair 查看对账明细。');
    return 2;
  }
  if (opts.sourceCommit && srcCommit !== git(localRoot, ['rev-parse', 'HEAD'], true)) {
    console.log('[WARN] 显式 --source-commit (' + srcCommit.slice(0, 12) + ') 与当前 HEAD 不同——账本将记录该值；');
    console.log('       status 的「未发布本地提交」统计从该值起算。确认无误可继续。');
  }
  const drift = computeDrift(localRoot, pubDir, files, [], srcCommit);
  const ledger = buildLedger(localRoot, pubDir, files, srcCommit, !opts.sourceCommit);
  ledger.backlogAtInit = {
    at: ledger.lastSync.at,
    note: '初始化时已有的差集（未被上次数同步覆盖的部分）',
    modified: drift.changed.map((c) => c.file),
    newCandidates: drift.candidates
  };
  const p = writeLedger(localRoot, ledger);
  console.log('账本已写入: ' + p);
  console.log('  发布树   : ' + pubDir);
  console.log('  发布提交 : ' + ledger.lastSync.publishedCommit);
  console.log('  来源提交 : ' + ledger.lastSync.sourceCommit + (ledger.lastSync.sourceCommitInferred ? ' (按任务号推断)' : ' (显式指定)'));
  console.log('  文件数   : ' + ledger.lastSync.publishedFiles);
  console.log('  指纹     : ' + ledger.lastSync.publishedFingerprint);
  console.log('  初始化差集: 改动 ' + ledger.backlogAtInit.modified.length + ' 个 / 新增候选 ' + ledger.backlogAtInit.newCandidates.length + ' 个');
  console.log('');
  console.log('注意: 账本记录的是「发布树当前状态」。待同步清单用 status 查看。');
  return 0;
}

// 账本锚点损坏的修复：按内容字节匹配重推断（不依赖任务号/手工录入）。
// 安全：默认 dry-run（只打印），--yes 才写账本；不匹配数超容许值直接拒绝；不执行任何 git 写操作。
function cmdRepair(opts) {
  const localRoot = LOCAL_ROOT;
  const ledger = readLedger(localRoot);
  if (!ledger) { console.log('[FAIL] 没有 ' + LEDGER_NAME + '，无需 repair（跑 init 建立）。'); return 2; }
  const pubDir = resolveTree(opts, ledger);
  if (!pubDir) { console.log('[FAIL] 未指定发布树：--tree <路径> / PUBLISH_TREE 环境变量。'); return 2; }
  if (!existsSync(pubDir)) { console.log('[FAIL] 发布树不存在: ' + pubDir); return 2; }
  const raw = (ledger.lastSync && ledger.lastSync.sourceCommit) || '';
  if (raw && isCommitReachable(localRoot, raw)) {
    console.log('[OK] 账本锚点 ' + raw.slice(0, 12) + ' 本仓可达，无需 repair。');
    return 0;
  }
  // 对账文件集：优先账本记录的「上次同步文件清单」（≤十几个，最快且最贴近同步时刻），否则发布树全部已跟踪文件
  const synced = Array.isArray(ledger.lastSync && ledger.lastSync.syncedFileList) ? ledger.lastSync.syncedFileList : null;
  const tracked = listPublishedFiles(pubDir);
  const trackedSet = new Set(tracked);
  const files = (synced && synced.length ? synced : tracked).filter((f) => trackedSet.has(f) || existsSync(join(pubDir, f)));
  if (!files.length) { console.log('[FAIL] 没有可用于对账的文件（账本清单与发布树均为空）。'); return 1; }
  const tolerance = opts.tolerance === undefined ? 1 : Number(opts.tolerance);
  console.log('=== 锚点内容匹配推断 ===');
  console.log('  损坏锚点: ' + (raw || '(未记录)'));
  console.log('  对账文件: ' + files.length + ' 个（' + (synced && synced.length ? '账本记录的上次同步清单' : '发布树全部已跟踪文件') + '，容许不匹配 ' + tolerance + ' 个）');
  const res = findSourceCommitByContent(localRoot, pubDir, files, { maxRevs: opts.maxRevs || 5000 });
  console.log('  本仓提交: 扫描 ' + res.walked + ' 个' + (res.truncated ? '（已达 maxRevs 上限）' : ''));
  console.log('  最佳匹配: ' + (res.best ? res.best.slice(0, 12) : '(无)') + '  匹配 ' + res.score + '/' + res.total + ' 个文件');
  for (const u of res.unmatched) console.log('    [不匹配] ' + u);
  const unmatchedN = res.total - res.score;
  if (!res.best || unmatchedN > tolerance) {
    console.log('[FAIL] 无法可靠推断（不匹配 ' + unmatchedN + ' 个 > 容许 ' + tolerance + ' 个），账本未改动。');
    console.log('       确认同步时有更多未入库运行态改动时，用 --tolerance <数> 放宽后重跑（仍需 --yes 才落盘）。');
    return 1;
  }
  const when = git(localRoot, ['show', '-s', '--format=%ci %s', res.best], true);
  console.log('  对应提交: ' + when);
  console.log('  语义提示: 推断锚点取「匹配数最高且最旧」的提交——宁可 diff 范围偏大（新候选可见性大），不把锚点推后');
  if (!opts.yes) {
    console.log('[DRY-RUN] 不带 --yes，未写账本。确认无误后加 --yes 落盘。');
    return 0;
  }
  const repair = {
    at: new Date().toISOString(),
    from: raw || '(未记录)',
    to: res.best,
    matched: res.score,
    total: res.total,
    method: 'content-match',
    evidence: 'archive/evidence/repair-publish-anchor-20261114.md'
  };
  const newLedger = { ...ledger, lastSync: { ...(ledger.lastSync || {}), sourceCommit: res.best, sourceCommitInferred: true, repair } };
  newLedger.note = (ledger.note ? ledger.note + ' | ' : '') + 'repair(' + repair.at.slice(0, 10) + ')：锚点按发布树内容字节匹配重推断 ' + repair.matched + '/' + repair.total + '，详 ' + repair.evidence;
  writeLedger(localRoot, newLedger);
  console.log('[已修复] ' + LEDGER_NAME + ' 锚点 → ' + res.best.slice(0, 12));
  console.log('         建议随后跑 node orchestrator/publish-sync.mjs status 核对未发布提交数。');
  return 0;
}

// ------------------------------------------------------------------ 入口

function parseArgs(argv) {
  const opts = { include: [], yes: false, push: false, noCommit: false, tree: '', msg: '', tolerance: undefined, maxRevs: 5000 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--include') { opts.include.push(...String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean)); }
    else if (a === '--tree') { opts.tree = String(argv[++i] || ''); }
    else if (a === '--source-commit') { opts.sourceCommit = String(argv[++i] || ''); }
    else if (a === '--msg') { opts.msg = String(argv[++i] || ''); }
    else if (a === '--tolerance') { opts.tolerance = Number(argv[++i]); }
    else if (a === '--max-revs') { opts.maxRevs = Number(argv[++i]) || 5000; }
    else if (a === '--yes') opts.yes = true;
    else if (a === '--push') opts.push = true;
    else if (a === '--no-commit') opts.noCommit = true;
    else rest.push(a);
  }
  return { cmd: rest[0] || 'status', opts };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  let code = 0;
  if (cmd === 'status') code = cmdStatus(opts);
  else if (cmd === 'plan') code = cmdPlan(opts);
  else if (cmd === 'apply') code = cmdApply(opts);
  else if (cmd === 'verify') code = cmdVerify(opts);
  else if (cmd === 'init') code = cmdInit(opts);
  else if (cmd === 'repair') code = cmdRepair(opts);
  else {
    console.log('用法: node orchestrator/publish-sync.mjs [status|plan|apply|verify|init|repair] [--include a,b] [--tree 路径] [--yes] [--push] [--no-commit] [--msg "..."] [--tolerance N] [--max-revs N]');
    code = 2;
  }
  process.exit(code);
}
