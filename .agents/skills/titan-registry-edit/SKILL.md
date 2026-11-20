---
name: titan-registry-edit
description: "【台账记忆】改台账走 edit-issue.mjs（内置写确认闸）；含跨会话持久记忆。触发词：登记任务 / 更新台账 / 改台账 / 记住这个"
user-invocable: true
version: 1.1.0
requires: node
tests: node orchestrator/pre-commit-check.mjs
provenance: original
---

# titan-registry-edit —— 台账条目自动编辑技能

## 问题背景

`ISSUE_REGISTRY.json` 是四客户端（OpenCode / Cline / Kilo / Harness）共享的单一任务台账（M0/M1）。历史上多次因手工 `editor` 替换 JSON 片段，导致 trailing comma、括号不匹配、引号转义错乱、重复条目等语法错误，整个文件不可解析，需反复修复（单条目编辑曾耗时 40 分钟）。

本技能统一通过脚本编辑台账，消除手工拼接 JSON 的语法错误。

## 1. 核心脚本：orchestrator/edit-issue.mjs

输入字段，自动生成条目并写回 `ISSUE_REGISTRY.json`，自动处理：
- JSON 转义（通过 `JSON.stringify`，无需手工转义引号/反斜杠）
- 逗号插入与括号闭合（通过对象方式 `root.issues[id] = entry` + `JSON.stringify`，无条目间逗号问题）
- 时间戳填充（claimed_at / in_progress_at / done_at，按状态自动）
- 合法性校验（type/status 必须在允许集合；id 不可重复）
- 写回前二次 `JSON.parse` 校验（防御性）

### 用法

```powershell
node orchestrator/edit-issue.mjs `
  --id T-131 `
  --title "示例条目标题" `
  --type fix `
  --status claimed `
  --owner cline `
  --description "条目说明文字" `
  --files ISSUE_REGISTRY.json `
  --files design-specs/xxx.md `
  --branch main
```

参数：
- `--id`（必填）：如 `T-131`
- `--title`（必填）
- `--type`（必填）：feat/fix/docs/chore/refactor/test/research
- `--status`（必填）：todo/claimed/in_progress/verifying/done/blocked
- `--owner`（必填）：客户端名（opencode/cline/kilo/harness）
- `--description`（必填）：条目说明
- `--files`（**非变参：必须逐条重复写 `--files A --files B`**；内部是 `flagAll('--files')`，写成 `--files A B C` 只会收下 A —— T-257 踩过）
- `--fields-json <路径>`：精确回填；**不能单独用**（必须配 `--id`），且 JSON 里**不许含 `id` 字段**（否则报「不允许的字段: id」）
- `--evidence '{"key":"path"}'`：证据路径必须真实存在，否则拒绝
- `--branch`（可选，默认 `main`）
- `--registry`（可选，默认 `ISSUE_REGISTRY.json`）
- `--verifier`（可选，done 后填交叉验证者）
- `--cv-verifier`（`--cv-status pass` 时必须 = 非作者客户端，如 kilo）：写 `cross_validation.verifier`，**不是** `--verifier`；T-363 首次误写成 `harness`（作者），已当场改正——不得把作者客户端记进任何验证字段，否则审计语义整个反转

退出码：0=成功，1=运行时错误，2=参数错误，3=JSON 校验失败。

### T-153 起：台账写入走「高风险写确认闸」

台账属高风险目标，`edit-issue.mjs` 内部已内置写闸（`orchestrator/lib/write-gate.mjs`）：

- 默认 **attested 确认**：调用方用 `--by <客户端名>` 署名（缺省取环境变量 `TITAN_ACTOR`），工具自动提案 → 打 diff 摘要 → 落盘，并把提案写进 run 事件账本（`orchestrator/run-events/`，运行期数据）。
- `--reason "<理由>"`：写进提案与账本（审计用）。
- `--defer`：**只提案不落盘**（打印 proposal id 与三步命令），需要人工过 diff 再写时用：

```powershell
node orchestrator/edit-issue.mjs --id T-131 ... --defer
node orchestrator/run-gate.mjs diff    --proposal <proposal_id>
node orchestrator/run-gate.mjs confirm --proposal <proposal_id> --by <确认人>
node orchestrator/run-gate.mjs apply   --proposal <proposal_id>
```

闸门红线：落盘前会二次校验目标哈希——提案生成后台账被他人改过就拒写，必须重新提案。

### 五个必踩的坑（2026-11-03 T-231/T-269/T-270 连续踩到，写进技能防复发）

| 坑 | 现象（逐字） | 正确做法 |
|---|---|---|
| `--files` 是**覆盖**不是追加 | 第一次传 3 个文件，把条目原有 4 个 files 冲掉了 | 一次传**全量**、且重复传参 `--files a --files b --files c` |
| 新建条目 `evidence_level` 默认 `unverified` | `[EDIT-ISSUE][CV-GATE] 拒绝: cv=pass 须配 evidence_level=firsthand，当…unverified` | 同一条命令里加 `--evidence-level firsthand`（也可后续单独补） |
| `--evidence` 的 JSON 里含 `/` 或 `\` 的字符串会被当路径校验 | `[EDIT-ISSUE][EVIDENCE-GATE] 拒绝: 证据文件不存在: <那段文字>` | 描述性文字**禁用斜杠**（写「jk-002 日本」不写 `jk-002(JP)`；写「type=https 加 server 加 path」不写 `type=https+server+path`） |
| 台账 `issues` 是**对象**不是数组 | `r.issues.filter is not a function` / `arr.find is not a function` | 取单条 `r.issues['T-270']`；遍历 `Object.values(r.issues)` |
| `done` 必须带 CV，否则整闸红 | verify-gate「done无CV闸」列 ID 并 FAIL | 先把 `--cv-status/--cv-verifier/--cv-evidence` 填好再标 `--status done`；`cv=pass` 还要求 verifier ≠ owner、证据不在 `tmp/`、证据首部含 `# client=` `# code=0` `# timedOut=false` `# prompt_sha256=`（或全文有 `VERDICT:` 行） |

`--stage-results` 传 JSON 文本：`'{"code":"PASS","artifact":"PASS","release":"UNKNOWN"}'`。

> 2026-11-10 追加（共享记忆已满 300 条，转录于此落盘）：
> - 改 `.agents/skills/*/SKILL.md` 后**必须** `node orchestrator/skill-manifest.mjs apply` 并同提交更新 `SKILL_MANIFEST.json`，否则 `orchestrator/test/skill-manifest.test.mjs` 红、verify-gate 记 1 败（T-352 实踩）。
> - 本仓 `.git/hooks/` 仅有 `.sample`、`core.hooksPath` 无重定向（2026-11-10 实测）——pre-commit 钩子未安装，commit 不会自动过闸；改技能/改闸后靠人工跑 `node --test orchestrator/test/skill-manifest.test.mjs` 等补救。重装需 `node orchestrator/install-hooks.mjs`（全局影响，待用户拍板）。

### 示例（认领新任务）

```powershell
node orchestrator/edit-issue.mjs --id T-131 --title "xx修复" --type fix --status claimed --owner kilo --description "说明..." --files ISSUE_REGISTRY.json
```

## 2. 提交前校验：orchestrator/pre-commit-check.mjs

任何提交 `ISSUE_REGISTRY.json` 前，必须先运行：

```powershell
node orchestrator/pre-commit-check.mjs
```

校验项：
- 文件可 `JSON.parse`
- 存在 `issues` 对象
- 每条条目具备全部必填字段（id/title/type/status/owner/description/files/evidence/cross_validation）
- `type`/`status` 在允许集合
- 条目 `id` 与对象键一致（无重复）

CI 已在 `.github/workflows/ci.yml` 中追加 `ISSUE_REGISTRY JSON 校验` 步骤，脏提交会被 CI 拦截。

## 3. 四客户端统一调用（M0/M1）

| 客户端 | 调用方式 |
|---|---|
| OpenCode | 终端执行 `node orchestrator/edit-issue.mjs ...` |
| Cline | 终端/PowerShell 执行 `node orchestrator/edit-issue.mjs ...` |
| Kilo | 终端执行 `node orchestrator/edit-issue.mjs ...` |
| Harness | `pwsh` 或 `bash` 执行 `node orchestrator/edit-issue.mjs ...` |

所有客户端共用同一个脚本与同一份 `ISSUE_REGISTRY.json`，无客户端特有分支。

## 4. 红线

1. **禁止直接手工编辑 `ISSUE_REGISTRY.json`**（通过 `editor` 替换片段），必须走 `edit-issue.mjs` + `pre-commit-check.mjs`。
2. 提交 `ISSUE_REGISTRY.json` 前必须先运行 `pre-commit-check.mjs`，且 CI 必须绿。
3. 只暂存/提交自己的文件（`git add <路径>`），不使用 `git add -A` 除非逐项确认。
4. 提交信息格式：`[T-xx] 类型: 描述`。
5. **不得绕过写闸**（T-153）：台账写入必须经 `edit-issue.mjs`（内含提案+署名确认），高风险文件（AGENTS.md / 发布树 / 密钥）必须经 `orchestrator/run-gate.mjs` 提案→确认→落盘；密钥类目标永不经过该闸落盘。

## 5. P2：JSONL 拆分评估（已评估，暂不执行）

`ISSUE_REGISTRY.json` 是四客户端共享的单一事实源，所有客户端的读写逻辑都基于单一 JSON 对象。拆分为 JSONL（每行一个条目）虽可让单条编辑不破坏整体，但会：
- 改变所有客户端的读写逻辑（需统一迁移，有撕裂风险）
- 破坏现有跨客户端对文件的一致性预期
- 在条目数较少时（当前 34 条）收益有限

**结论：暂不拆分。** 以 `edit-issue.mjs` + `pre-commit-check.mjs` 消除手工编辑错误即可。若未来条目数显著增长（如超过 200 条）或并发编辑冲突频发，再重新评估 JSONL 拆分。

## 6. T-352：台账分片（2026-11-10 落地）

**真相源 = `registry.d/<id>.json`（每条一文件）；`ISSUE_REGISTRY.json` = 自动聚合快照（canonical、可字节复现，sha256 稳定）。禁手工编辑快照。**

- 写路径：`edit-issue.mjs` 分片模式自动三文件落盘（分片 / 快照重聚合 / `_meta.json`），快照聚合 **git-aware**——只取 HEAD + 本次目标分片，绝不烘焙他端未提交分片（防夹带）。
- OCC 基点 = 目标分片字节（他端写别的条目不再误伤本端）。
- 提交边界：`pre-commit-check.mjs` 的 **LEDGER-SYNC** 会把「HEAD ∪ staged 分片」聚合与暂存快照核对，不一致则自动重写快照并重新暂存后再过闸（派生物确定性重放，非人工判断）——两端先后提交不再互相挡住。
- 闸门：`mixed-diff-gate` 要求 staged 分片 ⊆ claim manifest、且 staged 快照 == git-aware 聚合（手改快照必拦）。
- 合并冲突：只可能冲突在 `ISSUE_REGISTRY.json` / `_meta.json`（两派生文件）；`node orchestrator/tools/ledger-shard-snapshot.mjs --resolve --yes` 一键按磁盘分片重聚合收敛。
- 紧急修复：`registry.d/` 损坏或丢失 → `node orchestrator/tools/ledger-shard-migrate.mjs --rebuild-from-snapshot`（从快照重建分片，先自动备份到 `registry.d.bak-<ts>/`）。**迁移已执行一次，勿再跑默认 migrate**。
- 不变量：非目标分片写后字节零变更；快照 diff 只含目标条目 + `_meta` 哈希行；`_meta.json` 无时间戳（确定性）。
- 新建分片自动：`edit-issue --auto-commit` 会 `git add registry.d/<id>.json ISSUE_REGISTRY.json registry.d/_meta.json`。

---

<!-- 以下为已并入的原技能「titan-cross-session-memory」正文（存档保留，勿删） -->

# 原技能：titan-cross-session-memory

# Cross-Session Persistent Memory（跨对话持久记忆）

让一条命名记忆跨会话存活。两种模式，按用户消息判定，不依赖任何外部文档。

## 工具名按客户端不同（同一个存储）

| 客户端 | 工具名 |
|---|---|
| DeepSeek Harness | `memory_remember` / `memory_recall`（原生 8 工具） |
| OpenCode / Cline | `titan_memory_remember` / `titan_memory_recall`（MCP `titan`） |

读不到本表里的工具名就**换另一个名字试**，再不行改用兜底命令
`node titan-memory/cli.mjs recall '{"query":"X"}'`。三方写的是同一份
`~/.dsh/storages/dsh_memory.json`，A 存的 B 读得到。

## SAVE — 保存命名记忆

触发：用户说「做跨对话持久记忆，命名X」「记住X」「持久记忆X」「把这段存成 X」。

1. 提取记忆名 X（「命名」「记住」后面的标识符，如 `yyds`）。
2. 确定记忆内容：
   - 用户给了明确文本 → 直接用那段文本。
   - 用户没给 → 把当前会话里值得留到下次的东西压缩成一段（结论 / 状态 / 待办 / 禁忌），不得臆造。
3. 调用：
   `memory_remember(target="fact", kind="decision", tags=["cross-session-memory", "<X>"], text="<内容>")`
4. 把返回的 fact id 报给用户，并确认记忆名 X 已入库。

## LOAD — 加载命名记忆

触发：用户说「用跨对话持久记忆加载X」「加载X」「调出X」「读取记忆X」。

1. 提取记忆名 X。
2. 调用 `memory_recall(query="<X>")`。tag 命中优先，字面子串其次。
3. 命中 → 完整复述内容，附上 fact id。
4. 多条命中 → 列成清单让用户选。
5. 没命中 → 明确说「工作区里没有名为 X 的记忆」，不得编造内容。可提示检查拼写，或确认新会话是否还在同一个工作区。

## 硬边界（不可违反）

- 记忆是**工作区级**：绑定当前项目目录。新会话不在同一工作区，记忆就调不出来——这不是 bug。
  MCP 侧的工作区由 `TITAN_WORKSPACE` 固定（不是进程 cwd），所以换目录启动不会丢记忆。
- `memory_recall` 是**字面匹配**，不是语义匹配。query 必须用记忆里实际出现的词；记忆名本身最可靠，中英文都试。
  打分是三层：精确标签 → 模糊标签 → 文本子串；**模糊层会把 `titan` 当成 `titan-mcp-selftest` 的子串**，长 query 可能捞出不相干的旧条目，命中太多时改用记忆名本身。
- 容量：每工作区 300 条 fact，单条 ≤2000 字符。满了先 `memory_consolidate` 清理近重复。
- 内容不可臆造：`recall` 没结果就报没有，禁止凭记忆名猜内容。
- 默认写 `target="fact"`。只有用户明确要求「每次会话自动注入」才写 profile，且 profile 只有 8 条额度——**profile 只有 Harness 能写**，OpenCode/Cline 没这个工具。

## 台账写入事故补丁（2026-11-08 T-132 误翻复盘）

台账是**单文件巨大 JSON、全文件读-改-写**，写者旧快照会把整文件覆盖回旧值——任何条目的 status 都可能被"连带翻回"（已发生的：7aa38760、5144a85 把 T-132 从 done 翻成 in_progress；11-05 f4028e21 手修、11-08 5144a85 再翻坏）。

硬纪律（四条，不新增闸门——2026-11-04 用户裁定）：

1. 任何台账写入**前后都对全文件做 `git diff`**；禁止只核对自己的 id、禁止用旧快照全量重写。
2. 唯一写入入口 `orchestrator/edit-issue.mjs`（内置 attested 写闸 + TOCTOU 哈希校验）；自己动手整文件重写 = 误翻制造机。
3. 发现 `done→非done` 回退：先归因（事故连带 / 11-04「清闸降级欠账」/ 未吸收单），禁止盖毯式翻回 done；欠账诚实终点是 `blocked`（写明原因），不是 `in_progress` 装作在办。
4. 提交后做 **blob 级 status 对账**：`git show <sha>:ISSUE_REGISTRY.json` 解析每个 id 的 status 与上一提交逐条对比；`orchestrator/shell/titan-shell.mjs verify-change` 只能验语法/损坏词，验不出语义漂移。

T-132 案复现要点：done_at 从未为空（2026-10-21T01:04:02+08:00），description 早已载明"视为被后续任务吸收"；被两笔无关提交连带翻回两次。
下一次先查 done_at/description，再查 status 字段——别只看字段。
