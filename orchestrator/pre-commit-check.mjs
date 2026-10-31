#!/usr/bin/env node
// pre-commit-check.mjs —— 提交前/CI 校验：ISSUE_REGISTRY.json 必须可解析且条目结构完整
// 用法：node orchestrator/pre-commit-check.mjs [registry-path]
// 退出码：0=通过，1=失败
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { gitStagedFiles } from './lib/staged-files.mjs';
import { scanFiles } from './lib/secret-scan.mjs';
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

const staged = gitStagedFiles();
console.log('[PRE-COMMIT] 暂存文件: ' + (staged.length ? staged.join(', ') : '(无)'));

let vawOk = true;
let vcOk = true;
let ssOk = true;
if (staged.length > 0) {
  ssOk = runSecretScan(staged);
  vawOk = runVAW(staged);
}
vcOk = runVerifyChange();

if (!ssOk || !vawOk || !vcOk) {
  console.error('[PRE-COMMIT] 预提交闸门未通过（密钥扫描/写后验证/变更验证），提交被拦截。修复后重新暂存并再次提交。');
  process.exit(1);
}
console.log('[PRE-COMMIT] 预提交闸门全部通过（密钥扫描/写后验证/变更验证），允许提交。');
