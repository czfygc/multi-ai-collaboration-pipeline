#!/usr/bin/env node
// pre-commit-check.mjs —— 提交前/CI 校验：ISSUE_REGISTRY.json 必须可解析且条目结构完整
// 用法：node orchestrator/pre-commit-check.mjs [registry-path]
// 退出码：0=通过，1=失败
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gitStagedFiles, gitStagedRegularFiles } from './lib/staged-files.mjs';
import { SHARD_DIR, SHARD_META, aggregateFromIndex, gitListHeadShardIds, sha256Utf8, metaPayload } from './lib/ledger-aggregate.mjs';
import { scanFiles } from './lib/secret-scan.mjs';
import { verifyManifest, DEFAULT_MANIFEST_PATH, DEFAULT_SKILLS_ROOT } from './lib/skill-manifest.mjs';
import { runClaimGate } from './lib/claim-gate.mjs';
import { runMixedDiffGate } from './lib/mixed-diff-gate.mjs';
import { triage, collectWorktree } from './lib/wip-triage.mjs';
const registry = process.argv[2] ?? 'ISSUE_REGISTRY.json';
const ORCH = 'orchestrator';
let raw;
try { raw = readFileSync(registry, 'utf8'); } catch (e) {
  console.error('[PRE-COMMIT] 读取失败: ' + registry + ' -> ' + e.message); process.exit(1);
}
let root;
try { root = JSON.parse(raw); } catch (e) {
  console.error('[PRE-COMMIT] JSON 不可解析: ' + registry + ' -> ' + e.message);
  process.exit(1);
}
if (!root || !root.issues || typeof root.issues !== 'object' || Array.isArray(root.issues)) {
  console.error('[PRE-COMMIT] 缺少 issues 对象'); process.exit(1);
}
const issues = root.issues;
const required = ['id','title','type','status','owner','description','files','evidence','cross_validation'];
const validTypes = new Set(['feat','fix','docs','chore','refactor','test','research']);
const validStatuses = new Set(['todo','claimed','in_progress','verifying','done','blocked']);
let failed = 0;
let warned = 0;
for (const [id, entry] of Object.entries(issues)) {
  if (!entry || typeof entry !== 'object') { console.error('[PRE-COMMIT] 条目不是对象: ' + id); failed++; continue; }
  let missing = [];
  for (const k of required) {
    if (!(k in entry)) missing.push(k);
  }
  if (missing.length) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' 缺少字段: ' + missing.join(', ')); warned++; }
  if (entry.type && !validTypes.has(entry.type)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' type 非法: ' + entry.type); warned++; }
  if (entry.status && !validStatuses.has(entry.status)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' status 非法: ' + entry.status); warned++; }
  if (entry.id && entry.id !== id) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' id 与键不一致: id=' + entry.id); warned++; }
  if (!Array.isArray(entry.files)) { console.warn('[PRE-COMMIT] warn: 条目 ' + id + ' files 不是数组'); warned++; }
}
if (failed > 0) {
  console.error('[PRE-COMMIT] 校验失败，合计 ' + failed + ' 处严重问题，提交被拦截'); process.exit(1);
}
if (warned > 0) {
  console.warn('[PRE-COMMIT] 注意：合计 ' + warned + ' 处历史条目结构不完整（不阻断提交，建议逐条用 edit-issue.mjs 补全）');
}
console.log('[PRE-COMMIT] ISSUE_REGISTRY.json 校验通过，条目数: ' + Object.keys(issues).length + ' (警告 ' + warned + ')');

  // ---------- 密钥扫描闸门（T-245）----------
  function runSecretScan(files) {
    if (files.length === 0) return true;
    const hits = scanFiles(files);
    if (hits.length > 0) {
      for (const h of hits) {
        console.error('[PRE-COMMIT][SECRET-SCAN] ' + h.file + ':' + h.line + ' [' + h.type + '] ' + h.match);
      }
      return false;
    }
    console.log('[PRE-COMMIT][SECRET-SCAN] 无明文密钥');
    return true;
  }

  // ---------- 写后验证闸门（T-196）----------
// gitStagedFiles 抽至 lib/staged-files.mjs（中文路径 quotepath 修复，T-204）

function runVAW(files) {
  if (files.length === 0) return true;
  let allOk = true;
  for (const f of files) {
    const r = spawnSync(process.execPath, [join(ORCH, 'verify-after-write.mjs'), f], { encoding: 'utf8' });
    if (r.status !== 0) {
      console.error('[PRE-COMMIT][VAW-FAIL] ' + f + ' -> ' + (r.stdout || '').trim().slice(0, 200));
      allOk = false;
    }
  }
  return allOk;
}

function runVerifyChange() {
  const r = spawnSync(process.execPath, [join(ORCH, 'shell', 'titan-shell.mjs'), 'verify-change'], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('[PRE-COMMIT][VERIFY-CHANGE-FAIL] ' + (r.stdout || '').trim().slice(0, 300));
    return false;
  }
  return true;
}

// ---------- 客户端端点漂移提醒（T-257，**非阻断**：只提醒，绝不拦提交）----------
// 背景：Kilo/Cline 的 baseURL 一旦被指回 8787（bili 代理随会话起停的端口），表现为静默超时/ConnectionRefused。
function reportEndpointDrift() {
  try {
    const r = spawnSync(process.execPath, [join(ORCH, 'check-client-endpoints.mjs'), '--json'], { encoding: 'utf8' });
    if (r.status === 0) { console.log('[PRE-COMMIT][ENDPOINT] Kilo/Cline 端点无漂移'); return; }
    if (r.status === 2) {
      let drift = '?';
      try { drift = String(JSON.parse(r.stdout || '{}').drift); } catch { /* 保留 ? */ }
      console.warn('[PRE-COMMIT][ENDPOINT-DRIFT] 检出 ' + drift + ' 处 baseURL 漂移（Kilo/Cline 会静默超时/ConnectionRefused）→ 修回: node orchestrator/check-client-endpoints.mjs --fix');
      return;
    }
    console.log('[PRE-COMMIT][ENDPOINT] 巡检跳过（status=' + r.status + '）');
  } catch (e) {
    console.log('[PRE-COMMIT][ENDPOINT] 巡检异常，忽略: ' + (e && e.message ? e.message : e));
  }
}

const stagedAll = gitStagedFiles();
// gitlink(子模块指针)/删除项 不是可读文件，跳过密钥扫描与 VAW（T-257：否则正常子模块提交被 EISDIR 拦死）
const staged = gitStagedRegularFiles();
const skipped = stagedAll.filter((f) => !staged.includes(f));
console.log('[PRE-COMMIT] 暂存文件: ' + (stagedAll.length ? stagedAll.join(', ') : '(无)'));

// ---------- T-352：分片模式快照自动收敛（派生物，提交边界确定性重放聚合） ----------
// ISSUE_REGISTRY.json / registry.d/_meta.json 是 registry.d/*.json 的确定性派生物。
// 两端先后提交时，后一端的快照可能与「HEAD ∪ staged 分片」聚合不一致（他端已提交或手改）。
// 旧行为：mixed-diff-gate 硬拦，提交被挡住（复现 T-326/T-351 族「被他端挡住」）。
// 新行为：在提交边界自动按聚合重写并重新暂存——内容是纯函数，无人工判断，loud-logged。
// 前置条件：分片生态（HEAD 有分片 或 暂存区有分片）；纯快照同步/无关提交不动作。
function normRel(p) { return String(p || '').replace(/\\/g, '/').replace(/^[A-Za-z]:\//, '').toLowerCase(); }
function autoSyncLedgerSnapshot() {
  const nrm = stagedAll.map(normRel);
  const stagedShards = nrm.filter((f) => /^registry\.d\/[^/]+\.json$/.test(f) && !/_meta\.json$/.test(f));
  const hasStagedRegistry = nrm.includes('issue_registry.json');
  let shardedRegime = false;
  try { shardedRegime = gitListHeadShardIds(process.cwd()).length > 0 || stagedShards.length > 0; } catch { shardedRegime = stagedShards.length > 0; }
  if (!shardedRegime || (stagedShards.length === 0 && !hasStagedRegistry)) return true;
  let agg;
  try { agg = aggregateFromIndex({ repoRoot: process.cwd() }); } catch (e) {
    console.error('[PRE-COMMIT][LEDGER-SYNC] git-aware 聚合失败（fail-closed，提交被拦截）: ' + (e && e.message ? e.message : String(e)));
    return false;
  }
  const g = spawnSync('git', ['show', ':' + 'ISSUE_REGISTRY.json'], { cwd: process.cwd(), encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  const stagedRaw = g.status === 0 ? g.stdout.toString('utf8') : null;
  const want = agg.serialized;
  let changed = false;
  if (stagedRaw !== want) {
    try {
      writeFileSync(join(process.cwd(), 'ISSUE_REGISTRY.json'), want, 'utf8');
      changed = true;
    } catch (e) {
      console.error('[PRE-COMMIT][LEDGER-SYNC] 快照重写失败: ' + (e && e.message ? e.message : String(e)));
      return false;
    }
  }
  // _meta.json 同样是派生物：按聚合重生并重暂存（count + snapshot sha256）
  const metaWant = metaPayload(agg.count, sha256Utf8(want));
  const metaPath = join(process.cwd(), SHARD_DIR, SHARD_META);
  let metaChanged = false;
  try {
    const cur = existsSync(metaPath) ? readFileSync(metaPath, 'utf8') : null;
    if (cur !== metaWant) { writeFileSync(metaPath, metaWant, 'utf8'); metaChanged = true; }
  } catch (e) {
    console.error('[PRE-COMMIT][LEDGER-SYNC] _meta.json 重写失败: ' + (e && e.message ? e.message : String(e)));
    return false;
  }
  if (!changed && !metaChanged) {
    console.log('[PRE-COMMIT][LEDGER-SYNC] 快照 == HEAD∪staged 分片聚合，无需同步（' + agg.count + ' 条）');
    return true;
  }
  const addR = spawnSync('git', ['add', 'ISSUE_REGISTRY.json', 'registry.d/_meta.json'], { cwd: process.cwd(), encoding: 'utf8' });
  if (addR.status !== 0) {
    console.error('[PRE-COMMIT][LEDGER-SYNC] git add 失败: ' + String(addR.stderr || addR.stdout || addR.error || '').trim());
    return false;
  }
  console.log('[PRE-COMMIT][LEDGER-SYNC] 快照与 HEAD∪staged 分片聚合不一致（他端可能已提交台账，或本地快照被手改）——'
    + '已按聚合自动重写 ISSUE_REGISTRY.json 与 registry.d/_meta.json 并重新暂存。'
    + '快照是确定性派生物，本操作无人工判断、无内容选择；手工编辑快照不会静默落地。');
  return true;
}
const ledgerSyncOk = autoSyncLedgerSnapshot();
if (skipped.length) {
  console.log('[PRE-COMMIT] 跳过非普通文件(子模块指针/删除项，无内容可扫): ' + skipped.join(', '));
}

let vawOk = true;
let vcOk = true;
let ssOk = true;
let manifestOk = true;

// T-258：技能 manifest 前置闸——暂存任何 .agents/skills/*/SKILL.md 时，manifest 须与磁盘一致
function runManifestCheck(files) {
  const skillFiles = files.filter((f) => f.startsWith('.agents/skills/') && f.endsWith('SKILL.md'));
  if (skillFiles.length === 0) return true;
  const res = verifyManifest({ manifestPath: DEFAULT_MANIFEST_PATH, skillsRoot: DEFAULT_SKILLS_ROOT });
  if (res.ok !== true) {
    console.error('[PRE-COMMIT][MANIFEST-FAIL] SKILL.md 已变更但 skill-manifest 与磁盘不一致：');
    for (const iss of (res.issues || [])) {
      console.error('  - ' + iss);
    }
    console.error('  修复: node orchestrator/skill-manifest.mjs apply（再重新暂存 SKILL_MANIFEST.json）');
    return false;
  }
  console.log('[PRE-COMMIT][MANIFEST] skill-manifest 与磁盘一致（' + skillFiles.length + ' 个 SKILL.md 暂存）');
  return true;
}

if (staged.length > 0) {
  ssOk = runSecretScan(staged);
  vawOk = runVAW(staged);
  manifestOk = runManifestCheck(staged);
}

// T-261 M1 物理闸：暂存文件命中台账 files 列表 → 必须已由当前 owner 认领
let claimOk = true;
if (staged.length > 0) {
  const cg = runClaimGate(registry, staged);
  if (cg.error) {
    console.warn('[PRE-COMMIT][CLAIM-GATE] ' + cg.error + '（跳过认领闸，不阻断）');
  } else if (!cg.ok) {
    claimOk = false;
    console.error('[PRE-COMMIT][CLAIM-GATE] 拦截：以下台账条目未认领或 owner 不匹配，禁止提交：');
    for (const u of cg.unclaimed) {
      console.error('  - ' + u.id + ' owner=' + u.owner + ' status=' + u.status +
        (u.reason ? ' (' + u.reason + ')' : '') + ' filesHit=' + JSON.stringify(u.filesHit));
    }
    console.error('  修复：先 node orchestrator/edit-issue.mjs --id <id> --status claimed --owner <当前身份>，再提交。');
  } else {
    console.log('[PRE-COMMIT][CLAIM-GATE] 认领闸通过（' + cg.claimed.length + ' 条命中，均为当前 owner 已认领）');
  }
}

// T-273 开工闸：工作树里的悬空产物（台账外孤儿）在提交边界报警并拦截。
// 为什么需要它：claim-gate 的判据是「暂存文件」，而「干一半直接结束」根本不产生提交，
// 天然不在 claim-gate 的输入里 → 必须改成看工作树留下了什么。
// ---------- 台账混合 diff 绑定闸（2026-11-10 新增：拦截他端悬挂台账夹带）----------
// 规则：暂存的 ISSUE_REGISTRY.json 条目 diff ⊆ 本次认领条目（claim manifest）。
// 他端悬挂 T-334~T-350（507 行未提交）让任何客户端都无法原子认领并提交自己的条目
// ——本闸只允许「本次认领」的条目进 index；越权需显式 PRE_COMMIT_ALLOW_FOREIGN_REGISTRY=<id,id>。
let mixedOk = true;
{
  const mg = runMixedDiffGate({ repoCwd: process.cwd(), env: process.env });
  if (mg.skipped) {
    console.log('[PRE-COMMIT][MIXED-DIFF] 台账未暂存，闸门不适用');
  } else if (!mg.ok) {
    mixedOk = false;
    console.error('[PRE-COMMIT][MIXED-DIFF] ' + (mg.error || '拦截：台账含非本次认领条目'));
    if (mg.foreign) for (const id of mg.foreign) console.error('  - ' + id + ' （非本次认领）');
    console.error('  三选一：① 让 owner 先提交其台账并结账；② 自行认领这些条目（edit-issue.mjs）；③ 显式放行 PRE_COMMIT_ALLOW_FOREIGN_REGISTRY=<id,id>（精确列举，并将以 [BYPASS] 打印全量 foreign 清单）。');
  } else {
    console.log('[PRE-COMMIT][MIXED-DIFF] 台账 diff ⊆ 本次认领（' + (mg.allowed && mg.allowed.length ? mg.allowed.join(', ') : '无条目变更') + '）');
    if (mg.bypassed && mg.bypassed.length) console.warn('[PRE-COMMIT][MIXED-DIFF][BYPASS] 显式放行: ' + mg.bypassed.join(', '));
    if (mg.warning) console.warn('[PRE-COMMIT][MIXED-DIFF][BYPASS] ' + mg.warning);
  }
}

let wipOk = true;
{
  const wt = collectWorktree(process.cwd());
  if (!wt.ok) {
    console.warn('[PRE-COMMIT][WIP-TRIAGE] ' + wt.error + '（跳过巡检，不阻断）');
  } else {
    const wip = triage({ worktree: wt.paths, registry: root, nowIso: new Date().toISOString() });
    const high = wip.orphans.filter((o) => o.severity === 'high');
    if (high.length > 0) {
      wipOk = false;
      console.error('[PRE-COMMIT][WIP-TRIAGE] 拦截：工作树存在台账外的悬空产物（未登记/未认领的工作）：');
      for (const o of high) console.error('  - ' + o.path + ' → ' + o.detail);
      console.error('  三选一处理后重试：① 登记并认领该任务（edit-issue.mjs）② 归档到 archive/evidence/ ③ 确认无用后删除。');
      console.error('  巡检入口：node orchestrator/wip-triage.mjs');
    } else if (wip.orphans.length > 0) {
      console.warn('[PRE-COMMIT][WIP-TRIAGE] 提示：工作树有 ' + wip.orphans.length + ' 个一次性残骸待清理（不阻断）');
      for (const o of wip.orphans) console.warn('  · ' + o.path);
    } else {
      console.log('[PRE-COMMIT][WIP-TRIAGE] 工作树无台账外悬空产物');
    }
    if (wip.zombies.length > 0) {
      console.warn('[PRE-COMMIT][WIP-TRIAGE] 台账僵尸 ' + wip.zombies.length + ' 条（done 但 cv pending / 停滞未推进，不阻断；--strict 可拦）');
    }
  }
}

vcOk = runVerifyChange();
reportEndpointDrift(); // 只提醒，不参与 vcOk 判定

if (!ssOk || !vawOk || !vcOk || !manifestOk || !claimOk || !mixedOk || !wipOk || !ledgerSyncOk) {
  console.error('[PRE-COMMIT] 预提交闸门未通过（密钥扫描/写后验证/变更验证/认领闸/台账混合 diff 闸/悬空产物闸/LEDGER-SYNC），提交被拦截。修复后重新暂存并再次提交。');
  process.exit(1);
}
console.log('[PRE-COMMIT] 预提交闸门全部通过（密钥扫描/写后验证/变更验证/认领闸/台账混合 diff 闸/悬空产物闸/LEDGER-SYNC），允许提交。');
