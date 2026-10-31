#!/usr/bin/env node
// verify-gate.mjs — T-56 W1 双闸化：五段闸门 + R3 体量冻结闸 + 注入模板泄漏静态闸
// 用法: node orchestrator/verify-gate.mjs
// 退出码: 0=全绿, 1=有失败
//
// 段位（计划 W1 五段 + R3 两闸）:
//   ① 语法闸        -> 全部 *.mjs 跑 node --check（重复声明/括号截断等语法损坏）
//   ② 导入冒烟闸    -> 纯库模块真实 import 冒烟（错误依赖 / 非法导出）
//   ③ CLI 冒烟闸    -> autopilot/fixer-pool/delta-to-registry/titan-execute 四命令真实执行，
//                      断言无 ReferenceError/RangeError/require-not-defined；段内 <30s。
//                      背景：门禁 5 次假绿证明"语法合法但运行时炸"只能靠真跑抓。
//   ④ 测试闸        -> node --test orchestrator/test/；0 用例视为绿（W7 收敛后正式化）
//   ⑤ 自检闸        -> orchestrate.mjs --self-check（TDZ/require-in-ESM 等加载期炸弹）
//   ⑥ 注入模板泄漏静态闸 -> backtick 模板 span 内出现裸 Node 作用域标识符（denylist）
//                      = 修复-回归 fence（S-01 类：浏览器内 ReferenceError，Node 侧永不炸，
//                      只有静态扫描能抓）。活缺陷白名单允许已知条目，修复提交必须同步移除。
//   ⑦ 体量纪律闸（M12）-> 单文件源码 >50 KiB（51200 B）冻结只减不增 + 拆分义务；
//                      SIZE_LEDGER 维护超线台账，增长/新超线未登记 → FAIL。
//   ⑧ 动态 import 解析探针（T-68）-> 静态提取 import('...') 字面量核目标存在性。
//   ⑨ 损坏词静态闸（T-192）-> git 跟踪文本文件字节级扫写盘事故指纹
//                      （ufffd/nul/kunjin-kao/tangtangtang/object-object）；随机插词由
//                      verify-after-write.mjs + vaw-denylist.json 治理。
// 所有子命令带 watchdog 超时（无限递归类炸弹不会挂死闸门，超时即 FAIL）。

import { readdirSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NODE = process.execPath;
const failures = [];

function run(label, args, opts = {}) {
  // cwd 可由 opts.cwd 覆盖：测试闸必须固化为工作区根（T-59 实证：cwd=orchestrator/ 时
  // w6/meta 用例抖动 FAIL，cwd=根稳定 PASS——测试夹具路径语义绑定根目录）。
  const r = spawnSync(NODE, args, { cwd: opts.cwd || __dirname, encoding: 'utf8', timeout: opts.timeoutMs || 60000 });
  const errTag = r.error ? (': ' + (r.error.code === 'ETIMEDOUT' ? 'watchdog timeout' : r.error.message)) : '';
  if (r.status === 0 && !r.error) {
    if (!opts.silentPass) console.log('[GATE] PASS ' + label);
    return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
  }
  const detail = (((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-3).join(' | ') || errTag || ('exit ' + r.status));
  console.log('[GATE] FAIL ' + label + ' :: ' + detail);
  failures.push(label + ' :: ' + detail);
  return { ok: false, out: (r.stdout || '') + (r.stderr || '') };
}

// ① 语法闸门（orchestrator/ 顶层 + lib/ 子目录；T-56 W2.3 起覆盖 lib/ 新模块）
const libDir = join(__dirname, 'lib');
const shellDir = join(__dirname, 'shell');
const mjsFiles = readdirSync(__dirname).filter(f => f.endsWith('.mjs')).sort()
  .concat(existsSync(libDir) ? readdirSync(libDir).filter(f => f.endsWith('.mjs')).sort().map(f => join('lib', f)) : [])
  .concat(existsSync(shellDir) ? readdirSync(shellDir).filter(f => f.endsWith('.mjs')).sort().map(f => join('shell', f)) : []);
let syntaxOk = 0;
for (const f of mjsFiles) {
  if (run('syntax ' + f, ['--check', join(__dirname, f)]).ok) syntaxOk++;
}
console.log('[GATE] -- syntax ' + syntaxOk + '/' + mjsFiles.length + ' --');

// ② 导入冒烟闸门（纯库模块白名单；CLI 入口有顶层副作用，不入列）
const LIB_MODULES = ['cdp-client.mjs', 'review-flow.mjs', 'scan-flow.mjs', 'lib/constants.mjs', 'lib/prompts.mjs', 'lib/reviewers.mjs', 'lib/history-locks.mjs', 'lib/analyze-core.mjs', 'lib/decision-api.mjs', 'lib/session-nav.mjs', 'lib/session-send.mjs', 'lib/architect.mjs', 'lib/scan-entry.mjs', 'lib/contracts.mjs', 'lib/output-sandbox.mjs', 'lib/skill-quality.mjs', 'lib/run-events.mjs', 'lib/write-gate.mjs', 'lib/test-runner.mjs', 'lib/verify-profiles.mjs', 'lib/repo-scope.mjs', 'lib/lineage.mjs', 'lib/intent.mjs', 'lib/skill-manifest.mjs'];
let importOk = 0;
for (const f of LIB_MODULES) {
  if (!existsSync(join(__dirname, f))) {
    console.log('[GATE] FAIL import ' + f + ' :: 文件缺失');
    failures.push('import ' + f + ' :: 文件缺失');
    continue;
  }
  const code = "import('./" + f + "').then(function(){console.log('IMPORT_OK')}).catch(function(e){console.error('IMPORT_ERR: ' + e.message);process.exit(1)})";
  if (run('import ' + f, ['--input-type=module', '-e', code]).ok) importOk++;
}
console.log('[GATE] -- import ' + importOk + '/' + LIB_MODULES.length + ' --');

// ③ CLI 冒烟闸门：真执行（含 --help 半真执行），抓加载期 ReferenceError / RangeError / require-not-defined
const CLI_SMOKE = [
  ['CLI autopilot --dry-run', ['autopilot.mjs', '--dry-run']],
  ['CLI fixer-pool --dry-run', ['fixer-pool.mjs', '--dry-run']],
  ['CLI delta-to-registry --dry-run', ['delta-to-registry.mjs', '--dry-run']],
  ['CLI titan-execute --help', ['titan-execute.mjs', '--help']],
  ['CLI sandbox --help', ['sandbox.mjs', '--help']],
  ['CLI run-tests --help', ['run-tests.mjs', '--help']],
  ['CLI verify-profile --help', ['verify-profile.mjs', '--help']],
  ['CLI lineage --help', ['lineage.mjs', '--help']],
  ['CLI skill-manifest --help', ['skill-manifest.mjs', '--help']],
  ['CLI task-card --help', ['task-card.mjs', '--help']],
  ['CLI model-health --help', ['model-health.mjs', '--help']],
  ['CLI supervisor --help', ['supervisor.mjs', '--help']],
  ['CLI artifact-gate --help', ['artifact-gate.mjs', '--help']],
  ['CLI titan-shell --help', ['shell/titan-shell.mjs', '--help']],
];
const cliT0 = Date.now();
let cliOk = 0;
for (const [label, args] of CLI_SMOKE) {
  const r = spawnSync(NODE, args, { cwd: __dirname, encoding: 'utf8', timeout: 20000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const runtimeBomb = /ReferenceError|RangeError|require is not defined/.test(out);
  const ok = !r.error && r.status === 0 && !runtimeBomb;
  if (ok) { console.log('[GATE] PASS ' + label); cliOk++; }
  else {
    const detail = (runtimeBomb ? '运行时炸弹: ' + (out.match(/(ReferenceError|RangeError)[^\n]*/)?.[0] || '') : (r.error ? 'watchdog timeout' : 'exit ' + r.status));
    console.log('[GATE] FAIL ' + label + ' :: ' + detail);
    failures.push(label + ' :: ' + detail);
  }
}
const cliMs = Date.now() - cliT0;
if (cliMs > 30000) {
  console.log('[GATE] FAIL CLI 冒烟综合耗时 ' + cliMs + 'ms > 30s');
  failures.push('CLI 冒烟综合耗时 ' + cliMs + 'ms > 30s');
} else {
  console.log('[GATE] PASS CLI 冒烟耗时 ' + cliMs + 'ms < 30s');
}
console.log('[GATE] -- CLI ' + cliOk + '/' + CLI_SMOKE.length + ' --');

// ④ 测试闸：node --test 跑 orchestrator/test/ 下**全部**测试文件（递归子目录）；0 用例视为绿
// 坑（T-228 Kilo 复核发现）：早前用 readdirSync 只扫顶层，子目录（如 test/skill-evolution/）
// 里的测试**永远不会被提交闸发现** —— 测试存在但不拦任何东西，正是「有结构没行为」。
const testDir = join(__dirname, 'test');
const TEST_RE = /\.(test|spec)\.(mjs|js|cjs)$/;
function collectTestFiles(dir) {
  const found = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name.startsWith('_fixture')) continue;
      found.push(...collectTestFiles(full));
    } else if (e.isFile() && TEST_RE.test(e.name)) {
      found.push(full);
    }
  }
  return found.sort();
}
const testFiles = existsSync(testDir) ? collectTestFiles(testDir) : [];
let testOk = 0;
if (testFiles.length === 0) {
  console.log('[GATE] PASS node --test：0 用例（视绿；W7 收敛后正式化）');
} else {
  console.log('[GATE] 测试用例文件 ' + testFiles.length + ' 个（含子目录），node --test ...');
  const testArgs = ['--test'].concat(testFiles);
  const res = run('node --test orchestrator/test/', testArgs, { timeoutMs: 600000, cwd: join(__dirname, '..') });
  if (res.ok) testOk = testFiles.length;
  else {
    // 失败详情必须点名到用例：早先只打输出最后 3 行，红的可能在中间，
    // 打出来的全是通过的用例名 —— 等于"有失败但说不出是谁"，无法判断是否本次改动引入。
    const out = res.out || '';
    const lines = out.split(/\r?\n/);
    const names = [];
    let inFail = false;
    for (const l of lines) {
      if (/^✖ failing tests:/.test(l)) { inFail = true; continue; }
      if (inFail && /^\s*✖/.test(l)) { names.push(l.trim()); if (names.length >= 8) break; }
      if (inFail && /^\s*ℹ/.test(l)) break;
    }
    const summary = lines.filter(l => /^ℹ (tests|pass|fail) /.test(l)).join(' ');
    // 区分两种失败（口径不同，修法不同）：
    //   有汇总 + 有用例名  = 某些用例真红（改代码/测试）
    //   无汇总（ℹ tests 都没打出来）= 整轮被 watchdog 杀掉或加载期崩溃 —— 常因机器被其他测试/任务并行占用（M2 要求串行）
    if (!summary) {
      console.log('[GATE] 测试闸：无测试汇总 = 整轮被超时杀掉或加载期崩溃（非某用例红）；确认无其他测试并行、机器空闲后重跑');
      failures[failures.length - 1] = 'node --test orchestrator/test/ :: 整轮无汇总（被杀/超时/崩溃），非用例红';
    } else {
      console.log('[GATE] 测试闸失败明细 ' + summary);
      if (names.length) for (const n of names) console.log('[GATE]   ✖ ' + n);
      else console.log('[GATE]   （有用例级 fail 但没解析到失败用例名，见完整日志）');
      failures[failures.length - 1] = 'node --test orchestrator/test/ :: ' + summary +
        (names.length ? ' :: ' + names.join(' ; ') : ' :: (用例名未解析)');
    }
  }
}
console.log('[GATE] -- test ' + (testFiles.length === 0 ? '0/0' : testOk + '/' + testFiles.length) + ' --');

// ⑤ 自检闸门
run('self-check orchestrate.mjs', ['orchestrate.mjs', '--self-check']);
// P-19 时代的 A-orchestrate.mjs 备份件已在 T-49 退役（文件不存在）；原条件自检分支随之摘除
// （注：加载期炸弹教训由 orchestrate.mjs 本体的 self-check 继续覆盖）。

// ⑤' 交付闸（T-175）：本仓自身的许可证与第三方署名必须可判定且合格。
// 纪律：显式未知（UNKNOWN）不当通过——署名判不出来就不许提交。
// 但"可分发项目形态"才适用：仓库根没有 package.json 时（如干净沙箱自检）判为不适用，跳过而非误红。
// 产物段（清单）与发布段（匿名可下载）对"仓库本体"不适用，故此处只判许可证段；
// 三段语义用 stage-gate 复核，后两段未判即显式未知（发布前由发布流程单独判）。
const { checkLicenses } = await import('./lib/license-notice-check.mjs');
const { evaluateStages } = await import('./lib/stage-gate.mjs');
const repoRootForGate = join(__dirname, '..');
const distributableShape = existsSync(join(repoRootForGate, 'package.json'));
let licenseRes = { status: 'PASS', issues: [], deps_count: 0, notice_file: null, license_file: null, skipped: true };
if (distributableShape) {
  licenseRes = checkLicenses({ root: repoRootForGate, profileName: 'node-cli' });
  if (licenseRes.status === 'PASS') {
    console.log('[GATE] PASS 交付闸 许可证/第三方署名：PASS（依赖 ' + licenseRes.deps_count + ' 个，NOTICE=' + (licenseRes.notice_file || '无') + '）');
  } else {
    const detail = licenseRes.issues.map((i) => i.detail).join(' | ').slice(0, 300);
    console.log('[GATE] FAIL 交付闸 许可证/第三方署名：' + licenseRes.status + ' — ' + detail);
    failures.push('交付闸 许可证/第三方署名 ' + licenseRes.status + '：' + detail);
  }
} else {
  console.log('[GATE] PASS 交付闸 跳过：仓库根无 package.json（非可分发项目形态，不适用）');
}
const deliveryStages = evaluateStages({
  code: 'PASS',
  artifact: licenseRes.status === 'PASS' ? 'PASS' : null,
  release: null,
});
console.log('[GATE] -- 交付三段 ' + deliveryStages.summary + '（发布段未判 = 显式未知，不当发布通过） --');

// ⑥ 注入模板泄漏静态闸：backtick 模板 span 剥离 ${...} 后含裸 Node 作用域标识符即红。
// 依据：T-01（markerEnd 泄漏进浏览器模板）与 S-01（reviewer.url_open 裸引用）均为
// Node 侧永不报错、浏览器内 ReferenceError 的"哑弹"——语法闸/CLI 闸全盲，唯静态可得。
const TEMPLATE_DENYLIST = ['reviewer.url_open', 'markerStart()', 'markerEnd()', 'sha256OfBinaryFile('];
// 扫描前剥离注释：注释里的 backtick 示例（如 lib 头部引述旧缺陷形态）不是注入载荷。
// 行注释正则保留 "://" 前缀（模板字符串内 https:// ws:// 不应被误删；协议相对 // 极罕见，接受启发式）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
// 活缺陷白名单：file -> needle -> 仍存在的已知命中数。修复提交（W2.4 等）必须同步移除条目，
// 否则计数失配自动标红（防"修了但不摘白名单"的假绿）。
// T-56 W2.4：S-01（orchestrate.mjs 模板内裸 reviewer.url_open）已修复并摘条目——
// 此后任何模板内裸 reviewer.url_open 直接标红。
const LIVE_TEMPLATE_ALLOWLIST = {};
for (const f of mjsFiles) {
  const src = stripComments(readFileSync(join(__dirname, f), 'utf8'));
  const spans = src.match(/`[^`]*`/gs) || [];
  const counts = new Map();
  for (const sp of spans) {
    const cleaned = sp.replace(/\$\{[^}]*\}/g, '');
    for (const dn of TEMPLATE_DENYLIST) {
      counts.set(dn, (counts.get(dn) || 0) + (cleaned.split(dn).length - 1));
    }
  }
  for (const dn of TEMPLATE_DENYLIST) {
    const n = counts.get(dn) || 0;
    if (n === 0) continue;
    const allowed = (LIVE_TEMPLATE_ALLOWLIST[f] || {})[dn];
    if (allowed === n) {
      console.log('[GATE] WARN template-leak ' + f + ' :: ' + dn + ' x' + n + '（活缺陷白名单命中，修复提交必须摘条目）');
      continue;
    }
    const expect = (allowed === undefined) ? '（禁止出现）' : ('（白名单预期 ' + allowed + '）');
    console.log('[GATE] FAIL template-leak ' + f + ' :: ' + dn + ' x' + n + ' ' + expect);
    failures.push('template-leak ' + f + ' :: ' + dn + ' x' + n + ' ' + expect);
  }
}
console.log('[GATE] -- template-leak 静态扫描完成（denylist ' + TEMPLATE_DENYLIST.length + ' 项） --');

// ⑦ 体量纪律闸（AGENTS.md M12 宪法级，2026-10-13 用户拍板）：单文件源码 > 50 KiB（51200 B）
// → 冻结只减不增 + 拆分义务（登记拆分计划，目标回落 50 KiB 以下；新增功能一律新模块）。
// 机制：SIZE_LEDGER 维护"超线文件 → 冻结上限字节"；超线文件增长、或出现未登记的新超线
// 文件 → FAIL（新超线必须先登记拆分计划再提交）。阈值/账本变更见 M12（只降不升；上调=修宪）。
// 存量豁免史：orchestrate.mjs = T-59 批次上限 217000 B（2026-10-13 S6 拍板 212000；
// 2026-10-14 批2修复打穿后用户拍板上调 216000；同日批2c 修复打穿 +529B 后按 M12 程序
// 请示、用户拍板上调 217000——批2c 五条为 T-59 计划内行为修复）。
// T-61 拆分逐阶段下调链（M12 只降不升；SOP §6.6：实测+2KB 圆整）：217000 → P0 215000 →
// P1 192000 → P2 189000 → P3 182000 → P4 141000 → P5 120000（实测 117880）→ P6a 107000
// （实测 104628）→ P6b 68000（实测 65624）→ P7 54000（实测 51217）→ P8 43000（实测 40149，
// scan 块搬 lib/scan-entry.mjs；此后入口低于拆分线转休眠）。C-11 收官（2026-10-16）按 M12
// 程序**移除 orchestrate.mjs 条目**——入口 45,833B（R3/R5/R6/R7 空壳 +2,203B 仍 ≤50KiB），
// 全库 .mjs 均 ≤50KiB，拆分义务闭环；此后任何文件再超线按"新超线登记拆分计划"流程处理。
const SPLIT_THRESHOLD_BYTES = 51200;
const SIZE_LEDGER = {};
{
  const frozen = [];
  const sizeFails = [];
  for (const f of mjsFiles) {
    const key = f.replace(/\\/g, '/');
    const sz = statSync(join(__dirname, f)).size;
    if (sz <= SPLIT_THRESHOLD_BYTES) continue;
    const cap = SIZE_LEDGER[key];
    if (cap !== undefined && sz <= cap) frozen.push(key + ' = ' + sz + ' B <= 冻结 ' + cap + ' B');
    else sizeFails.push(key + ' = ' + sz + ' B' + (cap === undefined ? '（新超线未登记台账——先登记拆分计划再提交）' : ' > 冻结 ' + cap + ' B'));
  }
  if (sizeFails.length) {
    console.log('[GATE] FAIL size 体量纪律（M12）: ' + sizeFails.join(' ; '));
    failures.push('size 体量纪律（M12）: ' + sizeFails.join(' ; '));
  } else {
    for (const o of frozen) console.log('[GATE] WARN size 超 50KiB 拆分线（冻结在案，只减不增）: ' + o);
    console.log('[GATE] PASS size 体量纪律（M12：' + mjsFiles.length + ' 个 .mjs，超线冻结 ' + Object.keys(SIZE_LEDGER).length + ' 个）');
  }
}
// 汇总

// ⑧ 动态 import 解析探针（T-68）：静态提取 *.mjs 中 import('...') 字面量，按当前文件目录解析并核目标存在性。
// 语法闸与导入冒烟闸只加载模块顶层，不执行函数体内的动态导入；"路径拼错/移文件"类哑弹仅靠此静态探针抓。
function extractDynamicImportSpecs(src) {
  const re = /import\s*\(\s*(['"])(.*?)\1\s*\)/g;
  const specs = [];
  let m;
  while ((m = re.exec(src))) specs.push(m[2]);
  return specs;
}
let dynImportChecked = 0;
const dynImportFails = [];
  for (const f of mjsFiles) {
    const src = readFileSync(join(__dirname, f), 'utf8');
    for (const spec of extractDynamicImportSpecs(src)) {
      // 只查相对文件路径字面量（如 '../scan-flow.mjs'）：裸包名（'js-yaml'）、拼接字符串
      //（'" + f + "'）与模板量均不作静态断言，避免误报。
      if (!/^\.\.?\/[\w.\-]+(\/[\w.\-]+)*$/.test(spec)) continue;
      dynImportChecked++;
      const resolved = join(dirname(join(__dirname, f)), spec);
      if (!existsSync(resolved) && !existsSync(resolved + '.mjs')) {
        dynImportFails.push(f + ' :: import() 目标不存在: ' + spec + ' (解析为 ' + resolved + ')');
      }
    }
  }
if (dynImportFails.length) {
  console.log('[GATE] FAIL 动态 import 解析探针 :: ' + dynImportFails.join(' ; '));
  failures.push('动态 import 解析探针 :: ' + dynImportFails.join(' ; '));
} else {
  console.log('[GATE] PASS 动态 import 解析探针（' + dynImportChecked + ' 处 import() 均可解析）');
}
console.log('[GATE] -- 动态 import 解析探针完成 --');

// ⑨ 损坏词静态闸（T-192 写盘事故防线）：git 跟踪的文本文件做字节级快扫，
// 抓 ufffd 替换符 / NUL / kunjin-kao 类 GBK 乱码 / tangtangtang 填充 / object-object 字面量
// 等写盘事故指纹（指纹串在源码内拼接拆散，防自指命中）。
// 排除 archive/ reviews/ tmp/ _test/（历史证据只读 + 测试自脏）与二进制扩展名；
// VAW_ALLOWLIST 冻结只减不增（2026-10-24 存量清点：2 个历史文档），新命中 → FAIL。
// 随机插词（Mental/sper/大河/共 等"合法词"损坏）由 verify-after-write.mjs + vaw-denylist.json 治理， vaw-ok
// 此处只扫无争议字节指纹，避免静态闸误报合法词。
const VAW_ALLOWLIST = new Set([
  'design-specs/muse-ai-registration-report-20261021.md',
  'design-specs/proxy-direction-AE-integration.md',
]);
const VAW_BINARY_EXT = /\.(png|jpe?g|gif|ico|zip|gz|7z|exe|dll|pdf|woff2?|ttf|eot|mp3|mp4|sqlite|db|node|wasm|xlsx|docx|pptx)$/i;
const VAW_NEEDLES = [
  ['ufffd', Buffer.from([0xef, 0xbf, 0xbd])],
  ['nul-byte', Buffer.from([0x00])],
  ['kunjin-kao', Buffer.from('锟斤' + '拷', 'utf8')],
  ['tangtangtang', Buffer.from('烫烫' + '烫', 'utf8')],
  ['object-object', Buffer.from('[object ' + 'Object]', 'utf8')],
];
{
  const repoRoot = join(__dirname, '..');
  const ls = spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });
  const tracked = (ls.stdout || '').split(/\r?\n/).filter(Boolean);
  const scanned = [];
  const vawFails = [];
  for (const rel of tracked) {
    if (VAW_BINARY_EXT.test(rel)) continue;
    if (/^(archive\/|reviews\/|tmp\/|_test\/|node_modules\/|\.git\/)/.test(rel.replace(/\\/g, '/'))) continue;
    const abs = join(repoRoot, rel);
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile() || st.size > 2 * 1024 * 1024 || st.size === 0) continue;
    let buf;
    try { buf = readFileSync(abs); } catch { continue; }
    scanned.push(rel);
    for (const [tag, needle] of VAW_NEEDLES) {
      if (buf.includes(needle)) {
        if (VAW_ALLOWLIST.has(rel.replace(/\\/g, '/'))) continue;
        vawFails.push(rel + ' :: ' + tag);
      }
    }
  }
  if (vawFails.length) {
    console.log('[GATE] FAIL 损坏词静态闸 :: ' + vawFails.slice(0, 10).join(' ; ') + (vawFails.length > 10 ? ' …共 ' + vawFails.length + ' 处' : '')); // vaw-ok
    failures.push('损坏词静态闸 :: ' + vawFails.join(' ; '));
  } else {
    console.log('[GATE] PASS 损坏词静态闸（扫描 ' + scanned.length + ' 个跟踪文本文件，白名单冻结 ' + VAW_ALLOWLIST.size + ' 个）');
  }
}
console.log('[GATE] -- 损坏词静态闸完成 --');

console.log('');
if (failures.length > 0) {
  console.log('[GATE] ===== FAIL ' + failures.length + ' 项 =====');
  for (const f of failures) console.log('[GATE]   - ' + f);
  console.log('[GATE] RESULT: FAIL (exit 1)');
  process.exit(1);
}
console.log('[GATE] RESULT: OK (exit 0)');
process.exit(0);