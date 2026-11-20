# titan-memory — 四客户端共用的跨会话持久记忆

让 **DeepSeek Harness / Cline / OpenCode / Kilo Code** 读写**同一份**长期记忆。

| 客户端 | 接法 | 工具名 | 状态 |
|---|---|---|---|
| DeepSeek Harness | 原生 `dsh-native-memory` 插件（**未改动**） | `memory_remember` 等 8 个 | 本来就有 |
| OpenCode | `opencode.json` → `mcp.titan` | `titan_memory_remember` 等 16 个 | 已接通 |
| Cline | `.cline/mcp.json` + `~/.cline/data/settings/cline_mcp_settings.json` | `titan_memory_remember` 等 16 个 | 已接通 |
| Kilo Code | `.kilo/kilo.json` → `mcp.titan`（env `TITAN_CLIENT=kilo`） | `titan_memory_remember` 等 16 个 | 已接通 |
| 兜底 | `node titan-memory/cli.mjs <cmd> [json]` | 子命令 | 任一能跑 shell 的客户端可用 |

**共享的是存储，不是进程。** 四方都读写同一个文件：

```
~/.dsh/storages/dsh_memory.json
```

Harness 继续用它自己的八个工具（含 `memory_edit` / `memory_forget` / `memory_profile` / `memory_import`），
另外三家用本目录的 MCP server。因为指向同一份 JSON，A 客户端存的 B 客户端读得到。

## 本目录提供的 16 个工具

刻意少于 Harness 的 8 个原生工具 —— 只做**不依赖 DSH 运行时**的那部分，外加 T-293 的分层整理闭环 + T-295 P3 候选：

| 工具 | 说明 |
|---|---|
| `memory_remember` | 增/改一条 fact。`text` 必填非空；`kind` ∈ preference\|fact\|convention\|decision；`tags` 自由；传 `id` 即更新。≤2000 字符、每工作区 ≤300 条 active。**写入前过隐私过滤**，命中拒绝并返回 `MEMORY_PRIVACY_REJECTED` |
| `memory_recall` | 确定性关键词扫描。三层打分：**精确标签 +3 → 模糊标签 +1 → 忽略大小写文本子串 +2**，多词短语再 +4；同分按 `updatedAt` 新者优先。不传 query 列最新。返回 fact id，**每行附出处（`src <sessionId>#<seq>`）与 pinned 标记** |
| `memory_search` | 扫**过往会话日志**（`~/.dsh/sessions/` 下的 zstd JSONL），字面匹配，每会话取一段摘录。覆盖"从没被提升成 fact"的原始对话 |
| `memory_consolidate` | 默认只读报告（剩余容量 + 近重复合并候选，token 集 Jaccard ≥0.55，取前 5）。传 `{"apply": true}` 才把每对的**较旧**成员置为 `archived`（**不删**）；pinned 的跳过；可用 `memory_undo` 回退 |
| `memory_explain` | 只读出处与生命周期：kind / state / pinned / provenance（sessionId、seq、创建与更新时间）/ 备份份数 |
| `memory_pin` | 钉住一条 fact（`{"unpin": true}` 取消）。钉住的不会被 consolidate 归档、也不会被 forget 删除 |
| `memory_restore` | 把 `archived` 的 fact 复活为 `active`。硬删（`memory_forget`）的救不回来 |
| `memory_undo` | 回退本工作区最近一次 titan-journal 写入（remember 的增改、consolidate 归档、pin/unpin、restore）。`memory_forget` 不可撤销 |
| `memory_forget` | **不可逆硬删**：从共享库删除，并清掉同目录每个 `*.bak` 里的同一 id，再把 journal 中带内容的条目脱敏。默认 dry-run，只有 `{"confirm": true}` 才真删；pinned 的拒绝 |
| `memory_edit` | **T-295**：按 id 改一条 fact 的 text/kind/tags（需 memory_recall 出 id）。至少提供一个字段；隐私过滤和 2000 字符上限同 memory_remember；改前/改后写 journal，可 `memory_undo` 回退。 |
| `memory_profile` | **T-295**：读或替换本工作区的 always-injected profile（DSH 每轮注入的 notes 块）。不传 target 返回当前 entries；传 `target:"profile"` + `entries:[...]` 替换全部，上限 8 条/条 ≤240 字符，写入前过隐私过滤。 |
| `memory_import` | **T-296**：把耐久会话日志里看似值得记住的行导入为 fact。**不依赖 DSH 的 session-query FTS 句柄**：扫本工作区 zstd session 日志，抽取候选（复用 memory_candidates 的启发式：指令/教训/偏好/裁定标记），每条带 provenance `sessionId#seq/time/role`，再经 `memory_remember` 写入（隐私过滤 + 2000 字符 + 300 条容量检查）。默认 dry-run，只预览不写；传 `{"confirm": true}` 才真导入。导入的 fact 打 tags `['candidate','imported']`，可 `memory_recall query='imported'` 过滤，可 `memory_undo` 回退。 |
| `memory_core_recall` | **dsh-core-memory 风格本地检索**（纯 markdown 文件，与 DSH fact 表共存不冲突）：读 `<ws>/titan-memory/core/CORE.md`（核心记忆，≤3000 字符，每轮常驻候选）+ 关键词打分 `core/notes/*.md` 长尾笔记。零网络请求；关键词非语义，同义改写可能漏 |
| `memory_core_remember` | 写核心记忆 markdown（`CORE.md`，≤3000 字符）；传 `note=<id>` 写长尾笔记（`notes/<id>.md`，≤8000 字符/条）。文件可 git 版本管理 |
| `memory_coding_recall` | 编码记忆两层检索（scene + diff-chain），坐标 = file/function/branch |
| `memory_candidates` | **T-295 P3**：从最新会话日志里挖"像规则/教训/偏好/裁定"的行，**只推荐不写**。启发式：CJK/英文指令词（以后/必须/禁止/教训/根因/结论/我裁定/我要求…），隐私/重复/代码块/问句/极短行自动过滤。返回 `{text, kind, score, reasons, provenance(sessionId#seq)}`；调用方再用 `memory_remember` 落盘。 |

### 为什么 MCP 侧不再只有 4 个

- `memory_edit` / `memory_profile` —— 已加入本目录 MCP server（与 Harness 语义一致，共享同一份 `dsh_memory.json`）；`memory_import` **T-296 已实现**（会话日志→fact 导入，不依赖 DSH session-query FTS 句柄，默认 dry-run，`confirm:true` 才真写入；可 `memory_undo` 回退）。
- `memory_forget` 现在两边都有：Harness 的是软归档，本目录是**真删（含备份清理）**，语义不同，别混用。
- `memory_search` 的 DSH 版本走 sqlite FTS（`session-search.sqlite` ~200MB）。本目录的实现改为直接解日志，**结果排序与 Harness 不完全一致，但能力等价**。
- `memory_core_*` —— 2026-10-17 用户指令：dsh-core-memory（GitHub 404）思路落地为**共存增强**（不替换 titan-memory 也不替换 DSH fact 表）：纯 markdown + Node 原生 fs、零构建零依赖离线可用、数据即文件可 git 版本管理。检索本地打分，代价自述：关键词检索不是语义检索。

## T-293：与 sandy heng-dsh-memory 对齐的部分

对照 `design-specs/2026-11-06-记忆架构对齐heng-dsh-memory.md`，P1+P2 已落地：

| 能力 | 实现 |
|---|---|
| 隐私过滤 | 写入前确定性正则 + Luhn 卡号校验；命中拒绝（`MEMORY_PRIVACY_REJECTED`），不回显原文。覆盖口令/身份证/银行卡/手机号/API 密钥五类。13 位纯数字若是 `1` 开头的时间戳会放过，避免 `Date.now()` 被误杀 |
| 出处追溯 | recall 每行带 `src <sessionId>#<seq>`；`memory_explain` 给出完整 provenance |
| 确认制修改 | 所有写操作前 append `<store>.titan-journal.jsonl`（before/after 镜像）；`memory_undo` 一键回退 |
| 分层整理 | `pinned`（sidecar）、`consolidate --apply` 只归档不删、`memory_forget` dry-run + confirm、`memory_restore` |
| 本地存储 | 不变（`~/.dsh/storages/dsh_memory.json`） |

**`pinned` 为什么放 sidecar**：DSH 的 `FactSchema` 是 zod `z.object`，**会剥掉未知键**，写进 fact 的 `pinned` 字段会被 Harness 读时丢弃。所以钉住状态存 `<store>.titan-pins.json`，fact 行保持 DSH 形状不变。


## 关键实现事实（踩过的坑）

1. **会话日志是一个文件里拼接几千个 zstd frame**，不是单个 frame。
   `zstdDecompressSync` 和流式解压**都只吃第一帧**（10MB 文件解出 199 字节）。
   因此按 magic `28 B5 2F FD` 定位帧起点逐帧解码，解不出或不以 JSON 开头的丢弃。
2. **`workspacePath` 必须显式给**。MCP server 的 cwd 由客户端决定，而 fact 表按工作区精确分域 —— cwd 错一位就召回 0 条。
   所以四份配置里都写死了 `TITAN_WORKSPACE=<your-workspace>`。
3. **DSH 可能不认我写的 fact**。写盘前 `assertShape()` 逐字段校验 DSH 的 `FactSchema`
   （id/workspacePath/kind/text/tags/sessionId/seq/createdAt/updatedAt/state），
   任何一个不合法就**拒绝整次写入** —— 一行坏数据会让 Harness 的插件打不开整个 domain。
4. **并发**：我们自己的写入者用 `*.titanlock` 文件锁（陈旧 10s 自动抢、5s 超时抢）。
   DSH 不参与这把锁 —— 实测它只在真正操作记忆时才写文件（挂了 6 小时 mtime 不动），窗口很小。
   每次写盘前先留 `.bak`，写入走 `tmp + rename` 原子替换。
5. **打分/去重算法是逐行复刻** `dsh-native-memory`（MIT, highland0971）的纯函数，
   保证同一个 query 在 Harness 和 MCP 两侧给出相同排序。

## 环境变量

| 变量 | 作用 | 缺省 |
|---|---|---|
| `TITAN_WORKSPACE` | fact 表的 workspace 域 | `process.cwd()` |
| `TITAN_CLIENT` | 写入 fact 的来源标记 `mcp:<client>` | `unknown` |
| `TITAN_MEMORY_FILE` | 存储文件路径 | `~/.dsh/storages/dsh_memory.json` |
| `TITAN_SESSIONS_DIR` | 会话日志根目录 | `~/.dsh/sessions` |

## 验证

```powershell
cd <workspace>
node titan-memory\test.mjs          # 114/114：协议协商、往返、DSH schema、core memory、T-293 extras、memory_edit/memory_profile、错误路径、清理不留痕
node titan-memory\test-chain.mjs    # 33/33：编码记忆两层检索
node titan-memory\test-p3p4.mjs     # 3/3：P3 候选提取 + P4 本地 UI（token 保护、pin/forget/undo、不污染真库）
node titan-memory\verify-cline.mjs  # 14/14：Cline 接线回归
node titan-memory\cli.mjs recall '{"query":"10810","limit":5}'
node titan-memory\cli.mjs consolidate
node titan-memory\cli.mjs candidates '{"limit":10,"sessions":3}'
node titan-memory\cli.mjs edit '{"id":"...","text":"new text","tags":["a"]}'
node titan-memory\cli.mjs profile
```

`test.mjs` 会真实写入再**自行删除**测试 fact，跑完 `active facts` 数量复原。
**T-293 那段跑在 scratch 副本上**（`TITAN_MEMORY_FILE` 指向临时文件），绝不拿共享库做破坏性验证 —— 这是 2026-11-06 一次事故的教训（见 `archive/evidence/T-293/`）。

## 文件

| 文件 | 职责 |
|---|---|
| `store.mjs` | 文件锁、读写、FactSchema 校验、recall 打分、consolidate、隐私过滤、journal/undo、pin/restore/forget |
| `search.mjs` | 会话日志定位 + 多 frame zstd 解码 + 字面扫描 |
| `core-store.mjs` | core memory + 长尾笔记（纯 markdown，dsh-core-memory 思路） |
| `chain-store.mjs` | 编码记忆两层（scene 坐标 + diff-chain） |
| `server.mjs` | 零依赖 MCP stdio server（换行分隔 JSON-RPC 2.0），15 个工具 |
| `cli.mjs` | shell 兜底，同语义 |
| `test.mjs` / `test-chain.mjs` | 端到端测试 |
| `verify-cline.mjs` | Cline 配置 + 握手回归 |

**零 npm 依赖** —— 本机没有 `@modelcontextprotocol/sdk`，且 M7 要求不装用不上的东西。
`zstd` 用 Node 24 内置的 `node:zlib`。
