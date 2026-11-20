// orchestrator/lib/write-gate.mjs — T-153 高风险写确认闸（提案 → diff → 确认 → 落盘）
//
// 目的：把"改关键文件"这一步变成显式、可审计、可复核的动作，而不是随手 write 就生效。
//       借鉴 Nightingale 的写操作 proposal→diff→confirm；落地为最小实现：
//       只对四类目标加确认，其余目标不拦（不做通用告警平台）。
//
// 四类目标（高风险）：
//   constitution  AGENTS.md / SHARED_GIT_WORKSPACE_GUIDE.md —— 宪法与协作契约
//   ledger        ISSUE_REGISTRY.json / orchestrator/work-orders.json / orchestrator/limits.json
//   publish-tree  发布树（PUBLISH_SYNC.json 里的 publishTree 目录）及其子文件
//   secrets       titan_secrets.env 与 *.env 密钥文件
//
// 状态机：
//   proposed  --confirm-->  confirmed  --apply-->  applied
//      \                     （显式确认：Telegram 用户回「提交」）
//       \--> confirmed（attested：本地调用方带 --by/--reason 显式署名，diff 同步打印）
//
// 落盘前再校验一次 pre_sha256（TOCTOU 防护）：提案生成后目标被别人改过 → 拒写，要求重新提案。
//
// 铁律：
//   1. 提案未确认不得落盘；确认必须署名（by）+ 理由（reason）。
//   2. 落盘内容来自提案暂存区（staging/*.bin），确认与落盘之间内容不可变。
//   3. 每次提案/确认/落盘都写 run 事件账本（lib/run-events.mjs），可回放。
//   4. 密钥类目标永远只记账不落盘——密钥经环境变量/专用通道写，不走本闸。

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { atomicWriteFileSync } from './atomic-write.mjs';
import { basename, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger, newRunId } from './run-events.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const GATE_CATEGORIES = Object.freeze(['constitution', 'ledger', 'publish-tree', 'secrets']);

const CONSTITUTION_FILES = new Set(['AGENTS.md', 'SHARED_GIT_WORKSPACE_GUIDE.md']);
const LEDGER_FILES = new Set(['ISSUE_REGISTRY.json', 'work-orders.json', 'limits.json']);

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function readPublishTree(repoRoot = REPO_ROOT) {
  if (process.env.TITAN_PUBLISH_TREE) return resolve(process.env.TITAN_PUBLISH_TREE);
  const p = join(repoRoot, 'PUBLISH_SYNC.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && j.publishTree ? resolve(j.publishTree) : null;
  } catch { return null; }
}

function inside(child, parent) {
  if (!parent) return false;
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

export function classifyTarget(path, { repoRoot = REPO_ROOT, publishTree = readPublishTree(repoRoot) } = {}) {
  const abs = isAbsolute(path) ? resolve(path) : resolve(repoRoot, path);
  const name = basename(abs);
  if (CONSTITUTION_FILES.has(name)) return { category: 'constitution', rule: '宪法文件: ' + name, path: abs };
  if (LEDGER_FILES.has(name)) return { category: 'ledger', rule: '台账/限额文件: ' + name, path: abs };
  // T-352：registry.d/*.json（含 _meta.json）按 ledger 高风险处置
  const posixPath = abs.replace(/\\/g, '/').toLowerCase();
  if (/\/registry\.d\/[^/]+\.json$/.test(posixPath)) return { category: 'ledger', rule: '台账分片文件: ' + name, path: abs };
  // P1-06: 任意 `.env` / `.env.*` / `*.env` 一律按密钥文件判（此前 `.env` 被显式放行成 normal）
  if (name === 'titan_secrets.env' || /\.env($|\.)/.test(name)) {
    return { category: 'secrets', rule: '密钥文件: ' + name, path: abs };
  }
  if (publishTree && inside(abs, publishTree)) return { category: 'publish-tree', rule: '发布树内文件', path: abs };
  return { category: 'normal', rule: '普通文件', path: abs };
}

export function isHighRisk(category) {
  return GATE_CATEGORIES.includes(category);
}

function fileSha(abs) {
  if (!existsSync(abs)) return null;
  try { return sha256(readFileSync(abs)); } catch { return null; }
}

function gitDiff(oldPath, newPath) {
  const r = spawnSync('git', ['diff', '--no-index', '--no-color', '--unified=3', oldPath, newPath], { encoding: 'utf8', cwd: REPO_ROOT });
  if (r.error) return '';
  return r.stdout || '';
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function createGate({ root, repoRoot = REPO_ROOT } = {}) {
  const ledger = createLedger({ root: root || process.env.TITAN_RUN_EVENTS_DIR || join(REPO_ROOT, 'orchestrator', 'run-events') });
  const proposalsDir = ledger.proposalsDir;
  const stagingDir = ledger.stagingDir;

  function ensure() {
    ledger.ensure();
  }

  function proposalPath(pid) {
    if (!/^[A-Za-z0-9._-]+$/.test(String(pid || ''))) throw new Error('非法 proposal id: ' + pid);
    return join(proposalsDir, pid + '.json');
  }

  function save(proposal) {
    ensure();
    writeFileSync(proposalPath(proposal.id), JSON.stringify(proposal, null, 2) + '\n', 'utf8');
    return proposal;
  }

  function load(pid) {
    const p = proposalPath(pid);
    if (!existsSync(p)) return null;
    try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
  }

  function listProposals() {
    ensure();
    if (!existsSync(proposalsDir)) return [];
    const out = [];
    for (const f of readdirSync(proposalsDir)) {
      if (!f.endsWith('.json')) continue;
      const p = load(f.replace(/\.json$/, ''));
      if (p) out.push(p);
    }
    out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    return out;
  }

  // kind: 'write'（暂存字节→落目标文件）| 'commit'（暂存文件列表→git 提交）
  function createProposal({
    kind = 'write', targets = [], actor = 'unknown', reason = '', runId, note = '', message = null,
    confirmed = null, publishTree = readPublishTree(repoRoot),
  }) {
    if (!Array.isArray(targets) || !targets.length) throw new Error('提案必须有 targets');
    ensure();
    const id = 'prop-' + newRunId('').replace(/^run-/, '').replace(/^-+/, '');
    const run = runId || newRunId('gate');
    const stageDir = join(stagingDir, id);
    mkdirSync(stageDir, { recursive: true });
    const prepared = [];
    let idx = 0;
    for (const t of targets) {
      const abs = isAbsolute(t.path) ? resolve(t.path) : resolve(repoRoot, t.path);
      const cls = classifyTarget(abs, { repoRoot, publishTree });
      const preSha = fileSha(abs);
      const entry = {
        path: abs,
        rel: relative(repoRoot, abs).split('\\').join('/'),
        category: cls.category,
        rule: cls.rule,
        pre_sha256: preSha,
        pre_bytes: existsSync(abs) ? statSync(abs).size : null,
        stage_file: null,
        post_sha256: null,
        post_bytes: null,
      };
      if (kind === 'write') {
        const content = Buffer.isBuffer(t.content) ? t.content : Buffer.from(String(t.content ?? ''), 'utf8');
        const sf = join(stageDir, String(idx) + '.bin');
        writeFileSync(sf, content);
        entry.stage_file = sf;
        entry.post_sha256 = sha256(content);
        entry.post_bytes = content.length;
        idx++;
      }
      prepared.push(entry);
    }
    const proposal = {
      id,
      kind,
      status: 'proposed',
      confirm_mode: confirmed ? 'attested' : null,
      created_at: new Date().toISOString(),
      run_id: run,
      actor,
      reason,
      note,
      message: null,
      targets: prepared,
      confirmed_by: null,
      confirmed_at: null,
      applied_at: null,
      applied_files: [],
    };
    if (kind === 'commit') {
      proposal.message = message || (targets[0] && targets[0].message) || note || 'chore: gated commit';
    }
    save(proposal);
    ledger.append(run, 'proposal.created', {
      proposal_id: id, kind, actor, reason, note,
      targets: prepared.map(t => ({ rel: t.rel, category: t.category, pre_sha256: t.pre_sha256, post_sha256: t.post_sha256 })),
    });
    if (confirmed) {
      const by = confirmed.by || actor;
      const why = confirmed.reason || reason || 'attested by caller';
      proposal.status = 'confirmed';
      proposal.confirm_mode = 'attested';
      proposal.confirmed_by = by;
      proposal.confirmed_at = new Date().toISOString();
      proposal.reason = why;
      save(proposal);
      ledger.append(run, 'proposal.confirmed', { proposal_id: id, by, reason: why, mode: 'attested' });
    }
    return proposal;
  }

  function confirmProposal(id, { by, reason = '', runId } = {}) {
    const p = load(id);
    if (!p) throw new Error('提案不存在: ' + id);
    if (p.status !== 'proposed') throw new Error('提案状态不可确认: ' + p.status);
    if (!by) throw new Error('确认必须署名 (by)');
    p.status = 'confirmed';
    p.confirm_mode = 'explicit';
    p.confirmed_by = by;
    p.confirmed_at = new Date().toISOString();
    p.reason = reason || p.reason;
    save(p);
    ledger.append(runId || p.run_id, 'proposal.confirmed', { proposal_id: id, by, reason: p.reason, mode: 'explicit' });
    return p;
  }

  function rejectProposal(id, { by, reason = '' } = {}) {
    const p = load(id);
    if (!p) throw new Error('提案不存在: ' + id);
    p.status = 'rejected';
    p.confirmed_by = by || 'unknown';
    p.reason = reason;
    save(p);
    ledger.append(p.run_id, 'proposal.rejected', { proposal_id: id, by: by || 'unknown', reason });
    return p;
  }

  function diffForTarget(p, t) {
    if (p.kind !== 'write' || !t.stage_file) return '';
    if (t.pre_sha256 !== null) return gitDiff(t.path, t.stage_file);
    const empty = join(stagingDir, p.id, 'empty-' + basename(t.stage_file) + '.tmp');
    writeFileSync(empty, '', 'utf8');
    const d = gitDiff(empty, t.stage_file);
    try { rmSync(empty, { force: true }); } catch { /* 临时文件清理失败不阻塞 */ }
    return d;
  }

  function renderDiff(proposal) {
    const parts = [];
    for (const t of proposal.targets) {
      if (proposal.kind === 'write') {
        const d = diffForTarget(proposal, t);
        parts.push('--- ' + t.rel + '\n' + (d || (t.pre_sha256 === null ? '（新文件）\n' : '（内容无变化）\n')));
      } else {
        parts.push('--- ' + t.rel + '（提交模式：不改内容，仅纳入本次提交）');
      }
    }
    return parts.join('\n');
  }

  function summarize(proposal) {
    let added = 0;
    let removed = 0;
    const files = [];
    for (const t of proposal.targets) {
      let a = 0;
      let r = 0;
      if (proposal.kind === 'write' && t.stage_file) {
        const c = countDiffLines(diffForTarget(proposal, t));
        a = c.added;
        r = c.removed;
      }
      added += a;
      removed += r;
      files.push({ rel: t.rel, category: t.category, rule: t.rule, added: a, removed: r, post_sha256: t.post_sha256 });
    }
    const highRisk = proposal.targets.filter(t => isHighRisk(t.category)).map(t => t.rel);
    return { id: proposal.id, kind: proposal.kind, status: proposal.status, files, added, removed, highRisk, confirm_mode: proposal.confirm_mode };
  }

  function applyProposal(id, { by } = {}) {
    const p = load(id);
    if (!p) throw new Error('提案不存在: ' + id);
    if (p.status !== 'confirmed') throw new Error('提案未确认，拒绝落盘: ' + p.status);
    const secretTargets = p.targets.filter(t => t.category === 'secrets');
    if (secretTargets.length) {
      ledger.append(p.run_id, 'write.blocked', { proposal_id: id, files: secretTargets.map(t => t.rel), reason: '密钥类目标不经过本闸落盘（只记账）' });
      throw new Error('密钥类目标不经过本闸落盘（只记账）: ' + secretTargets.map(t => t.rel).join(', '));
    }
    const applied = [];
    if (p.kind === 'write') {
      for (const t of p.targets) {
        const cur = fileSha(t.path);
        if (cur !== t.pre_sha256) {
          ledger.append(p.run_id, 'write.blocked', { proposal_id: id, path: t.rel, reason: '目标已变更（TOCTOU），需重新提案' });
          throw new Error('目标在提案后被改动，拒绝落盘（需重新提案）: ' + t.rel);
        }
      }
      for (const t of p.targets) {
        const content = readFileSync(t.stage_file);
        const actual = sha256(content);
        if (t.post_sha256 && actual !== t.post_sha256) throw new Error('暂存内容哈希不符，拒绝落盘: ' + t.rel);
        atomicWriteFileSync(t.path, content);
        applied.push(t.rel);
      }
    } else {
      const rels = p.targets.map(t => t.rel);
      const add = spawnSync('git', ['add', '--', ...rels], { cwd: repoRoot, encoding: 'utf8' });
      if (add.status !== 0) throw new Error('git add 失败: ' + (add.stderr || add.stdout || '').trim());
      const msg = p.message || 'chore: gated commit';
      const commit = spawnSync('git', ['commit', '-m', msg, '--', ...rels], { cwd: repoRoot, encoding: 'utf8' });
      if (commit.status !== 0) {
        ledger.append(p.run_id, 'write.blocked', { proposal_id: id, reason: 'git commit 失败', stderr: String(commit.stderr || '').slice(0, 300) });
        throw new Error('git commit 失败: ' + String(commit.stdout || commit.stderr || '').trim().slice(0, 300));
      }
      applied.push(...rels);
    }
    p.status = 'applied';
    p.applied_at = new Date().toISOString();
    p.applied_files = applied;
    p.applied_by = by || p.confirmed_by;
    save(p);
    ledger.append(p.run_id, 'proposal.applied', { proposal_id: id, by: p.applied_by, files: applied });
    return p;
  }

  return {
    ledger, root: ledger.root, proposalsDir, stagingDir,
    createProposal, confirmProposal, rejectProposal, applyProposal,
    load, listProposals, renderDiff, summarize, proposalPath,
  };
}

export const gate = createGate();
export default gate;
