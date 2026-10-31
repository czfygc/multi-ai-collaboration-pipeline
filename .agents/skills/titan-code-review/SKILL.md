---
name: titan-code-review
description: "【评审复核】评审分支、PR 或未完成改动：双轴并排报告 —— 规范轴（AGENTS.md + 仓库约定 + Fowler 异味）与规格轴（台账任务 + 设计稿），不重排、不越权改代码。触发词：评审 / 复查改动 / 能不能合 / review"
version: 1.1.0
requires: none
tests: "manual: 拿一个真实 diff 跑双轴评审并核对 Standards 与 Spec 两侧结论"
provenance: adapted:mattpocock/skills#unversioned-MIT
---

# TITAN 双轴代码评审

对"从某个固定点到 HEAD"的 diff 做两轴评审：

- **Standards 轴**：改动是否符合本仓**有明文**的规范？
- **Spec 轴**：改动是否忠实实现了台账任务/设计规格？

两轴用**并行子代理**跑，避免互相污染上下文，最后只汇总、不合并排序。

来源：改写自 mattpocock/skills 的 `code-review`（MIT, Copyright (c) 2026 Matt Pocock），接入 TITAN 的台账、M2 交叉验证与仓库规范。

## 与 TITAN 流程的分工

| 事项 | 归属 |
|---|---|
| 谁有权最终验收 | M2：**作者不许自己验收**；本技能用于"送审前自检"或"验证者复核" |
| 标准从哪来 | AGENTS.md（M1-M7）、SHARED_GIT_WORKSPACE_GUIDE.md、TOOL_CONSTRAINTS.md、SUITES.md、周边代码风格 |
| 规格从哪来 | `ISSUE_REGISTRY.json` 的 T-xx 条目 + `design-specs/` 对应文档 + 提交信息 |
| 验证证据 | `archive/evidence/T-xx/`；台账 `evidence` / `cross_validation` |

## 流程

### 1. 钉固定点

用户给的固定点就是它（commit SHA / 分支 / tag / `main` / `HEAD~5`）。没给就问。

```bash
git diff <fixed-point>...HEAD        # 三点，对 merge-base 比较
git log <fixed-point>..HEAD --oneline
```

先确认固定点能解析（`git rev-parse <fixed-point>`）且 diff 非空。坏 ref 或空 diff 要在这里失败，不要带进两个子代理。

### 2. 找规格来源

按顺序找：

1. 提交信息里的任务号（本仓为 `[T-xx]`，不是 GitHub `#123`）。
2. 用户显式给的路径。
3. `design-specs/` 下与任务/分支匹配的文档。
4. 都没有就问用户。用户说没有 → Spec 轴跳过并写"无规格可用"。

读 `ISSUE_REGISTRY.json` 时只看该任务条目：`title` / `description` / `files` / `evidence`，不要通读全表。

### 3. 找规范来源

搜出所有"代码该怎么写"的文档。以下必须在内：

- `AGENTS.md`（M1-M7 是硬约束）
- `SHARED_GIT_WORKSPACE_GUIDE.md`
- `orchestrator/test/SUITES.md`（测试登记口径）
- `TOOL_CONSTRAINTS.md`（若存在）
- 被改文件周边的现有写法（命名、错误处理、日志前缀、导入顺序）

在上述明文之外，Standards 轴**始终携带**下面的 Fowler 坏味道基线。两条约束：

- **仓库明文优先**：仓库鼓励的写法，基线不得判为问题。
- **永远是判断题**：写成"疑似 Feature Envy"，不是硬违规。工具已经强制的项（格式、lint）直接跳过。

每条坏味道是"是什么 → 怎么修"，对着 diff 找：

- **Mysterious Name 名不副实**：函数/变量/类型名看不出用途或内容 → 改名；起不出诚实的名字说明设计本身浑浊。
- **Duplicated Code 重复代码**：同一逻辑形状出现在多个 hunk/文件 → 抽出来共用。
- **Feature Envy 依恋情结**：方法大量访问别人的数据 → 把方法搬到它所依恋的数据上。
- **Data Clumps 数据泥团**：几个字段/参数总是结伴出现 → 合成一个类型。
- **Primitive Obsession 基本类型偏执**：用字符串/数字顶替领域概念 → 给概念一个小类型。
- **Repeated Switches 重复 switch**：同一类型的 switch/if 级联反复出现 → 多态或共享映射表。
- **Shotgun Surgery 霰弹式修改**：一个逻辑改动逼你散改很多文件 → 把一起变的东西聚到一个模块。
- **Divergent Change 发散式变化**：一个文件因多个不相关原因被改 → 拆到各自模块。
- **Speculative Generality 夸夸其谈通用性**：为规格里没有的需求加抽象/参数/钩子 → 删掉，等真需求出现再抽象。
- **Message Chains 过长的消息链**：`a.b().c().d()` 让调用方依赖整条链 → 在第一个对象上藏起整段走位。
- **Middle Man 中间人**：类/函数基本只做转发 → 去掉，直接调用目标。
- **Refused Bequest 被拒绝的遗赠**：子类忽略/覆盖大部分继承物 → 改用组合，不用继承。

### 4. 并行发两个子代理

两个调用**同一条消息一起发**，前台等结果。工具按客户端选：OpenCode 用 Task；其他客户端用 `titan-headless-clients` 技能里的后台调用模板。

**Standards 子代理 prompt** 必含：

- diff 命令与 commit 列表。
- 第 3 步找到的规范文件路径清单，**外加坏味道基线全文**（子代理看不到本技能）。
- 任务说明："逐文件/逐 hunk 报告：(a) 违反明文规范之处，引用规范文件+规则；(b) 基线坏味道，命名并引用 hunk。区分硬违规与判断题：明文违规可硬，基线永远是判断；仓库明文覆盖基线；工具已强制的跳过。400 字以内。"

**Spec 子代理 prompt** 必含：

- diff 命令与 commit 列表。
- 规格路径或内容。
- 任务说明："报告：(a) 规格要求但缺失/只做一半的；(b) diff 里规格没要求的（范围蔓延）；(c) 看着实现了但实现方式可疑的。每条引用规格原句。400 字以内。"

无规格 → 跳过 Spec 子代理并在汇总里注明。

TITAN 硬检查项（两轴之外，必须单列并给出证据）：

- [ ] `node orchestrator/verify-gate.mjs` 全绿（贴 `RESULT: OK`）
- [ ] 台账已认领/推进，提交信息带 `[T-xx]`
- [ ] 没有密钥、缓存、浏览器数据、`node_modules` 进暂存（M5）
- [ ] 根目录没有新增散文件（M2 根目录纪律）
- [ ] 新增/修改的源码文件未越过 50 KiB 拆分线（M4 体量纪律）
- [ ] 新测试已登记 `SUITES.md`；修复类提交带回归测试（R1）
- [ ] 证据已落 `archive/evidence/T-xx/`，台账 `evidence` 有指针
- [ ] 一次性脚本已清理（`tmp/`、`_probe_*`、`_shot_*`）

### 5. 汇总

按 `## Standards` 与 `## Spec` 两个标题分别呈现两份报告（原文或轻度整理）。**不要合并、不要跨轴重排**——两轴分开正是为了互相不能遮掩。

结尾一行：每轴发现数 + 该轴最严重的一项（若有）。不要选出跨轴总冠军。

另附 TITAN 硬检查项结果（逐项 PASS/FAIL/证据）。

## 为什么必须分两轴

- 规范全对但做错了东西 → **Standards 过，Spec 挂**。
- 完全按规格做但破坏仓库约定 → **Spec 过，Standards 挂**。

合并排序会让一轴掩盖另一轴。M2 的最终验收仍由**非作者**客户端执行，本技能不改变验收权归属。
