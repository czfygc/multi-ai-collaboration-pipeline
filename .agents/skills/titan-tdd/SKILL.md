---
name: titan-tdd
description: "【开发测试】TDD 红绿重构：先确认接缝、每次一条竖切片、测试落 orchestrator/test/ 并登记 SUITES.md、每个修复提交都带回归测试；含「跑测试只看结构化结论」速读（自动识别 vitest/jest/pytest/node:test/npm test）。触发词：TDD / 红绿重构 / 先写测试 / 加回归测试 / 跑测试 / 测试失败"
version: 1.1.0
requires: node
tests: "manual: 走一次红绿重构并确认测试已进 SUITES.md"
provenance: adapted:mattpocock/skills#unversioned-MIT
---

# TITAN TDD（红-绿-重构）

一个循环：**先写会失败的测试（红）→ 只写到通过（绿）→ 重构交给 code-review**。
本技能规定"什么算好测试、测试放哪、循环怎么走"，每一轮都适用。

来源：改写自 mattpocock/skills 的 `tdd`（MIT, Copyright (c) 2026 Matt Pocock），按 TITAN 仓库约定重写。

## 与 TITAN 流程的分工

| 事项 | 归属 |
|---|---|
| 这个任务该不该做、谁在做 | `ISSUE_REGISTRY.json`（M1） |
| 测试放哪、怎么写、循环规则 | 本技能 |
| 验收由谁做 | AGENTS M2：作者不许自己验收 |
| 写盘安全、体量纪律 | AGENTS M4（反斜杠通道、50 KiB 拆分线） |

## 好测试的标准

测试验证**行为**，不验证实现细节。代码可以整体重写，测试不该跟着改。
好的测试读起来像规格：`T-145 沙箱：大日志被压到预算内且保留关键信号` 一眼知道能力边界。

反面典型：

- **耦合实现**：mock 内部协作者、测私有函数、绕过接口查数据库。特征：重构就红，行为没变。
- **同义反复**：期望值用和被测代码同样的算法算出来（`expect(add(a,b)).toBe(a+b)`），永远不可能失败。期望值必须来自独立来源：已知字面量、手工算例、规格原文。
- **横切**：先写一大批测试再写实现。那是在测"想象的行为"。要**纵向切片**：一个测试 → 一个实现 → 下一轮。

## 接缝（seam）：测试写在哪

接缝 = 你观察行为的**公开边界**。测接缝，不测内部。

- 动手前先写下本次要测的接缝，并用一句话说明"能抓到什么 / 抓不到什么"。
- 新增/变更公开接口时，先和用户确认接缝（M6：给 2-3 个选项 + 推荐）。
- 测试选点优先级：关键路径 > 复杂逻辑 > 边界情况。不可能全覆盖，别假装能。

## 循环规则

- **红在绿前**：先让测试因正确的原因失败，贴出失败输出作为证据（M2）。
- **一次一片**：一个接缝、一个测试、一个最小实现。
- **不预支未来**：不写"以后可能要用"的测试或参数。
- **重构不占循环**：行为不变的结构调整放到 code-review 阶段做。

## TITAN 落地约定

1. **位置**：`orchestrator/test/<模块>.test.mjs`；用 `node:test` + `node:assert/strict`，零外部依赖。
2. **登记**：新测试文件必须加进 `orchestrator/test/SUITES.md` 的表格（Suite / 文件 / 覆盖）。
3. **跑法**：`node --test orchestrator/test/<文件>`；全量 `node --test orchestrator/test/`；闸门 `node orchestrator/verify-gate.mjs` 的 ④ 段会自动跑全量。
4. **临时目录**：`mkdtempSync(join(tmpdir(), 'prefix-'))`，`finally` 里 `rmSync(dir, { recursive: true, force: true })`，不污染仓库。
5. **确定性**：不依赖当前时间、随机数、网络、机器语言环境；需要时先播种/冻结输入。
6. **密钥**：fixture 里不放真实 token（M5）；日志类输入先脱敏。
7. **回归债 R1**：任何 fix 提交至少携带 1 个新测试；bug 修复先有红灯测试。
8. **证据**：把红灯与绿灯两次运行的原始输出摘录写进 `archive/evidence/T-xx/`，台账填 `evidence`。
9. **代码风格**：不加注释（除非用户要求）；错误信息给可操作的事实，不写空话。

## 完成判据

- [ ] 接缝已确认并记录
- [ ] 每个切片：红 → 绿，失败/通过输出都留证
- [ ] 新测试已登记 SUITES.md
- [ ] `node --test orchestrator/test/` 全绿，`verify-gate` 全绿
- [ ] 重构项已列出，交给 code-review（不在本循环内做）

---

<!-- 以下为已并入的原技能「titan-test-runner」正文（存档保留，勿删） -->

# 原技能：titan-test-runner

# titan-test-runner —— 四客户端共享测试运行器

## 一句话

```powershell
node orchestrator/run-tests.mjs
```

**只回结构化摘要**（通过/失败统计 + 失败用例名与错误行 + 输出尾部），不倒整段原始测试输出——省 token、省一轮往返。

## 为什么需要它

原始 `node --test` / `pytest` 输出动辄几百上千行，模型要读完整个输出才能知道"哪几个用例挂了、为什么挂"。本工具把它压成一页摘要：

```
test_run framework=node exit=1 0.9s
command: node --test
SUMMARY: 42 tests -> 41 passed, 1 failed, 0 skipped
1) bad case
   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal
```

## 参数

| 参数 | 说明 |
|---|---|
| `--cwd <目录>` | 在哪个目录跑（默认仓库根） |
| `--framework auto\|vitest\|jest\|pytest\|node\|npm-test` | 缺省 auto：package.json 依赖 → scripts.test → pyproject/pytest.ini/conftest → test 目录或 *.test.* |
| `--target <模式>` | 跑哪个文件/目录/用例（如 `tests/t.py::test_login`）；多个用空格分隔 |
| `--last-failed` | 只重跑上次失败（vitest `--lastFailed` / jest `--onlyFailures` / pytest `--lf`） |
| `--timeout <ms>` | 超时（默认 120000） |
| `--command <命令>` | 完全自定义命令（跳过框架探测与默认命令构造） |
| `--json` | 输出 JSON（给脚本/其它客户端消费） |
| `--tail <字符数>` | 输出尾部保留长度（默认 800） |
| `--max-failures <n>` | 摘要里最多列几个失败用例（默认 8） |

退出码：`0` = 全绿；`1` = 有失败/超时/执行错误；`2` = 用法错误。

## 典型闭环（写代码 → 改 → 测 → 验）

1. 改完代码，跑 `node orchestrator/run-tests.mjs --target orchestrator/test/<你的用例>.mjs`。
2. 只看摘要里的失败用例名 + 错误行——**不用**去翻原始输出。
3. 修完再跑一次；全绿再进 verify-gate 复核。

```powershell
# 一步到位：本仓全量回归（35+ 测试文件）
node orchestrator/run-tests.mjs --cwd <workspace> --framework node
```

## 三条硬约束（别绕过）

1. **target 不安全字符会被拒**（只允许路径/glob/`::` 用例名；`& ; $ \` >` `..` 等一律拒绝）——不可信文本不进 shell。
2. **解析失败必须退化安全**：只回 `exitCode` + 输出尾部，**绝不谎报通过**。看到 `note: 未解析到框架摘要` 就是没解析到，按 exitCode 判断。
3. **不改被测项目任何文件**：只读 + 执行测试命令。

## 边界（如实说明）

- 解析器覆盖 vitest / jest / pytest / node:test 的**默认 reporter 输出**；框架改版或自定义 reporter → 退化为 exitCode + 尾部。
- `go test` / `cargo test` 等没有专用解析器 → 走通用关键字统计，失败用例名可能拿不到（只有统计）。
- `last_failed` 在 node / npm-test 下不支持（会忽略并跑全量，输出里有 note 提示）。
- 本工具**不替代** verify-gate：verify-gate 是"过闸判定"（语法/导入/CLI/测试/自检/体量/动态 import 七段），本工具是"跑测试拿摘要"。改完 orchestrator 代码的规矩仍是 `node orchestrator/verify-gate.mjs` 全绿才允许提交。

## 出处与许可

思路借鉴 DeepSeek Harness 插件 [suimi8/dsh-test-runner](https://github.com/suimi8/dsh-test-runner)（MIT）——自动探测框架 + 只回结构化摘要。本技能是**仓内重写**：零依赖、客户端无关、可被四客户端共用，代码在 `orchestrator/lib/test-runner.mjs` + `orchestrator/run-tests.mjs`，测试在 `orchestrator/test/run-tests.test.mjs`。
