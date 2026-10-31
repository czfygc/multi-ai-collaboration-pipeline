// orchestrator/lib/pipeline-stage.mjs — T-162 全流程阶段编排（R1 实装，拆后 P12）
//
// 定位：把 orchestrate.mjs 里 5 个"已注册但未实现"的 stub（design/plan/implement/deliver/pipeline）
//       变成真模式——**框架真、内容源按可用性降级**：
//   - 阶段产物落 reviews/pipeline-<id>/stage-0N-<stage>/（计划 §8 P12 约定的路径）；
//   - 产物字段沿用 R2 冻结的 PIPELINE_STAGE_FIELDS（schemaVersion/pipelineId/stage/
//     parentStageId/inputs/outputs/decisions/artifacts/timestamp），只追加不改名；
//   - 每份产物带 evidenceLevel：real（真实链路产出）/ local-placeholder（本地占位，
//     与 architect-local 同口径）/ pending（需人工/执行器补做）——**不谎报完成**。
//   - --pipeline 串链：按 design→plan→implement→deliver 依次驱动，任一阶段失败即停，
//     停下前把已完成阶段的产物与失败原因落证据（pipeline-<id>/evidence.json）。
//
// 红线：
//   1. 本模块**不改被测/业务文件**——implement 阶段只产出"执行单"（交给 titan-execute），
//      真正改码仍走执行器 + verify 前置（不改既有纪律）。
//   2. 阶段之间靠文件契约交接，不共享可变状态（可单独回放任一阶段）。
//   3. 不碰既有 12 个 active 模式的任何行为。

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

export const STAGE_ORDER = Object.freeze(['design', 'plan', 'implement', 'deliver']);
export const STAGE_SCHEMA_VERSION = 'v1';
export const STAGE_DIRS = Object.freeze({
  design: 'stage-01-design',
  plan: 'stage-02-plan',
  implement: 'stage-03-implement',
  deliver: 'stage-04-deliver',
});
export const EVIDENCE_LEVELS = Object.freeze(['real', 'local-placeholder', 'pending']);

export function pipelineRoot(reviewsRoot = join(REPO_ROOT, 'reviews')) {
  return join(reviewsRoot, 'reviews');
}

export function createPipeline({ pipelineId, reviewsRoot = join(REPO_ROOT, 'reviews') } = {}) {
  const id = pipelineId || ('pipeline-' + Date.now().toString(36));
  const dir = join(reviewsRoot, id);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return { id, dir, reviewsRoot };
}

export function stageDir(pipeline, stage) {
  const name = STAGE_DIRS[stage];
  if (!name) throw new Error('未知 stage: ' + stage);
  const dir = join(pipeline.dir, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// 写阶段产物（字段名 = R2 冻结的 PIPELINE_STAGE_FIELDS + 追加的 evidenceLevel/notes）
export function writeStageArtifact(pipeline, stage, {
  parentStageId = null, inputs = {}, outputs = {}, decisions = [], artifacts = [],
  evidenceLevel = 'real', notes = '', startedAt = null,
} = {}) {
  if (!EVIDENCE_LEVELS.includes(evidenceLevel)) throw new Error('非法 evidenceLevel: ' + evidenceLevel);
  const dir = stageDir(pipeline, stage);
  const finishedAt = new Date().toISOString();
  const obj = {
    schemaVersion: STAGE_SCHEMA_VERSION,
    pipelineId: pipeline.id,
    stage,
    parentStageId,
    inputs,
    outputs,
    decisions,
    artifacts,
    timestamp: finishedAt,
    evidenceLevel,
    notes,
  };
  // T-168：阶段耗时（**追加**字段，不改冻结字段名）。
  // 为什么加：实测一次整链 636s，但 stage.json 只有单个 timestamp，
  // 无法拆出"哪一段慢"——效率优化没有度量就无法复算。
  if (startedAt) {
    const startedMs = typeof startedAt === 'number' ? startedAt : Date.parse(startedAt);
    if (Number.isFinite(startedMs)) {
      obj.startedAt = new Date(startedMs).toISOString();
      obj.finishedAt = finishedAt;
      obj.durationMs = Date.parse(finishedAt) - startedMs;
    }
  }
  const file = join(dir, 'stage.json');
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return { file, dir, artifact: obj };
}

export function readStageArtifact(pipeline, stage) {
  const file = join(stageDir(pipeline, stage), 'stage.json');
  if (!existsSync(file)) return null;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function listPipelineStages(pipeline) {
  const out = [];
  if (!existsSync(pipeline.dir)) return out;
  for (const d of readdirSync(pipeline.dir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const file = join(pipeline.dir, d.name, 'stage.json');
    if (!existsSync(file)) continue;
    try { out.push(JSON.parse(readFileSync(file, 'utf8'))); } catch { /* 坏产物跳过 */ }
  }
  out.sort((a, b) => {
    const ia = STAGE_ORDER.indexOf(a.stage);
    const ib = STAGE_ORDER.indexOf(b.stage);
    if (ia !== -1 && ib !== -1) return ia - ib;   // 按流水线顺序（design→plan→implement→deliver）
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return String(a.stage).localeCompare(String(b.stage));
  });
  return out;
}

// 串链证据（成功/失败都落）
export function writePipelineEvidence(pipeline, { ok, failedStage = null, reason = '', stages = [] } = {}) {
  const file = join(pipeline.dir, 'evidence.json');
  const obj = {
    pipelineId: pipeline.id,
    ok: !!ok,
    failedStage,
    reason,
    stages,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  return file;
}

// 找最近一次 pipeline（按 mtime 倒序）——用于 plan/implement/deliver 续跑
export function latestPipeline({ reviewsRoot = join(REPO_ROOT, 'reviews') } = {}) {
  if (!existsSync(reviewsRoot)) return null;
  let dirs;
  try { dirs = readdirSync(reviewsRoot, { withFileTypes: true }); } catch { return null; }
  const cands = [];
  for (const d of dirs) {
    if (!d.isDirectory() || !d.name.startsWith('pipeline-')) continue;
    const full = join(reviewsRoot, d.name);
    let mtime = 0;
    try { mtime = statSync(full).mtimeMs; } catch { mtime = 0; }
    cands.push({ id: d.name, dir: full, mtime });
  }
  cands.sort((a, b) => b.mtime - a.mtime);
  if (!cands.length) return null;
  return { id: cands[0].id, dir: cands[0].dir, reviewsRoot };
}

export default {
  STAGE_ORDER, STAGE_SCHEMA_VERSION, STAGE_DIRS, EVIDENCE_LEVELS,
  createPipeline, stageDir, writeStageArtifact, readStageArtifact, listPipelineStages, writePipelineEvidence,
  latestPipeline,
};
