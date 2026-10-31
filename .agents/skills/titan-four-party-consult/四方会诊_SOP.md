# 四方会诊（Four-Party Consult）标准化操作流程 SOP

> 版本：v1.0（基于 2026-09-30 实战踩坑复盘固化）
> 适用：`orchestrator/orchestrate.mjs` 及其 reviewers.yaml 配置
> 维护：按需更新，**不生成新坑**
> **挂载关系（T-03）**：执行核心（前置检查/标准命令/红线）已内联至 `.agents/skills/titan-four-party-consult/SKILL.md` 的 `SOP gate` 节，技能触发即注入；本文件是 **canonical 详版**（坑库/基线/报告模板）。**改任何一边必须同步另一边并提交。**

---

## 0. 一句话核心

> **三方汇聚 → delta.md → 一次性直送 ChatGPT**，空 delta 走本地短路，**严禁**用空 delta/测试 prompt 反复灌 ChatGPT。

### 0.1 Mode 2：复杂问题 4 席同题交叉审问（2026-10-22 用户裁定，与 SKILL.md `Mode 2` 节同步）

> 8 个月失败开发总结："复杂的问题把 chat.deepseek.com / chat.qwen.ai / gemini.google.com /
> chatgpt.com 四个一起交叉审问，能解决 99.9% 的问题。"

- **用途**：审**问题**（方案/难 bug/架构决策/收口复核），不是审 artifact；不经 pipeline 层。
- **同题同料**：四席发同一份 brief（同一证据摘录），否则发现不可比、冲突检测失效。
- **一次四席**：不许先问一家再决定问不问别家；只问 1~2 席就宣布"复核完成" = 违规。
- **无损归档**：各席原文整段落 `archive/evidence/<T-xx>/web/<seat>.md`；去重是第二步。
- **缺席补位**：上传失败/挑战页/超时 → 补位重发，缺口显式标注；单席结论 ≠ 复核完成。
- **逐条核验**：假发现照样浪费一轮；真发现改完必须跑回归再回写证据。
- 完成判据：四席齐 + 归档 + 逐条核验 + 冲突/盲区汇总一份。
- 实证：T-168 本轮 DeepSeek 抓 3 条、ChatGPT 抓 5 条 P1，互为盲区（单席都看不全）。

---

## 1. 前置条件清单（派单前必核，逐项打钩）

| # | 检查项 | 命令/动作 | 通过标准 |
|---|--------|-----------|----------|
| 1 | CDP 端口可达 | `curl -s http://127.0.0.1:9222/json/version` | HTTP 200 + 返回 Browser/Protocol-Version |
| 2 | Chrome 进程带持久 profile | `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | ? CommandLine -match 'user-data-dir'` | 含 `--user-data-dir=<workspace>\chrome-cdp-profile` |
| 3 | 三方 reviewer tab 全在线 | `curl -s http://127.0.0.1:9222/json/list \| jq '.[] \| select(.url | test("gemini|deepseek|qwen"))'` | 至少 3 个 tab，url 对应且 `type=="page"`（席位名单以 reviewers.yaml enabled 为准；2026-10-12 起 gemini/deepseek/qwen） |
| 4 | ChatGPT tab 就绪 | `curl -s .../json/list \| jq '.[] \| select(.url | test("chatgpt"))'` | `type=="page"`，url `chatgpt.com`，**非** "Just a moment..."、非挑战页 |
| 5 | 无遗留挑战 | `<workspace>\.agents\skills\titan-four-party-consult\tools\_probe_chatgpt.mjs` | `challenge=false, editor=true, bodyLen>100` |
| 6 | reviewers.yaml thresholds 正确 | `cat orchestrator/reviewers.yaml \| grep -A5 thresholds` | `blind_spot_to_delta: HIGH; single_reviewer_to_delta: HIGH` |
| 7 | 回归基线跑通（代码改动后必跑） | `node orchestrate.mjs --analyze 66c0f00e` + `_fixture_stest2` | 断言与 `_session_memory.md` 第 2 节完全一致 |

> ❗ 任一项不通过 → **禁止派单**，先修环境。

---

## 2. 派单标准命令

```powershell
# 正式四方会诊（单条命令，自动：dispatch → analyze → architect）
cd <workspace>\orchestrator
node orchestrate.mjs --review <artifact-path> --analyze --architect
```

- `<artifact-path>`：待审文件/目录绝对路径（例：`<workspace>\orchestrator\orchestrate.mjs`）
- **严禁**加 `--force` 除非明确要绕过去重重跑（且知晓后果）
- 不要拆成多条命令跑（`--review` 单跑会卡在等待 reviewer，**必须**链式 `--analyze --architect` 让编排器自动串起）

### 2.1 轻量冒烟测试（非正式验收，仅跑通链路）

```powershell
# 用 _fixture_stest2（4 个 mock raw，秒级跑完，不触发真实 CDP 审阅）
node orchestrate.mjs --analyze _fixture_stest2
```

- 仅验证 **Layer B 分析链 + architect 短路** 逻辑，不依赖外部浏览器。
- 正式验收前先跑这一行，确保分析逻辑无回归。

---

## 3. 执行阶段预期与关键观测点

| 阶段 | 关键日志 | 通过标准 | 常见异常 & 排查 |
|------|----------|----------|-----------------|
| **Dispatch** | `[REVIEW] dispatchId=xxxxxxxx` | 生成 8-hex id；history 写入 | `DISPATCH_FAILED` → 查 `layer-a/raw/*-log.json` 的 `error` 字段 |
| **Reviewer** | `gemini: OK textLen=XXXX` | 三方 `textLen > 0`，**不能为 0** | `textLen=0` → 必是 `pollOnce ReferenceError`（`markerEnd` 泄漏）或 CDP 会话掉线 |
| **Analyze** | `[ANALYZE] issues=NN deltas=M` | `deltas >= 0`；`conflicts/blind_spots/backlog` 合理 | `issues=0` 且 `textLen>0` → 正则提取失败（`verdictLines=0`） |
| **Architect** | `[ARCHITECT] inject ok / submit ok` | `inject={"ok":true}` → `formatOk=true`（或仅 WARN） | `fresh page load poll timeout` → ChatGPT 挑战页或未登录；`formatOk=false` 且 `missing=[...]` → 捕获文本不含 accept/reject/defer |

> **红线**：任一 reviewer `textLen=0` → **直接判定失败**，不进入 analyze/architect；必须先修捕获层 bug。

---

## 4. 结果验收清单（验收即数据）

| 产物 | 路径 | 必检字段 |
|------|------|----------|
| Layer A raw | `reviews/<dispatchId>/layer-a/raw/<reviewer>.md` | `textLen>0`、含结构化 ISSUE/severity |
| Layer A meta | `reviews/<dispatchId>/layer-a/issues-normalized.json` | `issues` 数组非空、`occurrences` 映射完整 |
| Layer B delta | `reviews/<dispatchId>/layer-b/delta.md` | `## DELTA 项` 列表、filtered 记录、counts 一致 |
| Architect 决策 | `reviews/<dispatchId>/layer-b/architect-decision.md` | 源 `source: delta.md ...`、逐条 `accept|reject|defer`、**非占位** |

> 自动化验收脚本（建议后续加入）：解析上述 4 个文件，断言字段非空、格式合规 → CI 绿灯。

---

## 5. 常见坑 & 规避动作（按本次实战固化）

| 坑 | 现象 | 根因 | 规避动作（已固化入代码/流程） |
|----|------|------|-------------------------------|
| **reviewer textLen=0 全灭** | 三方全 `OK textLen=0` | `buildSnapshotScript`/`buildEditorStateScript` 模板里写 `markerEnd()` → 浏览器 `ReferenceError` | ✅ 已修：模板用 `${JSON.stringify(markerEnd())}` 插值；**严禁**在模板里写 Node 函数调用 |
| **architect 捕获为空** | `ARCHITECT_CAPTURE_EMPTY` | (1) 50 字符下限误杀 32 字符短裁决；(2) ChatGPT 挑战页导致 fresh-chat 超时 | ✅ 下限 50→10；✅ 空 delta 短路（不发 CDP）；fresh-chat 30s 超时+挑战检测 |
| **ChatGPT 反复挑战** | fresh-chat 超时/注入失败 | Cloudflare Turnstile 每次导航触发 | 1) 持久 profile（已 `--user-data-dir`）；2) 派单前跑 `tools/_probe_chatgpt.mjs`；3) 遇挑战跑 `tools/_try_turnstile.mjs` 点一次（不行再 `tools/_reload_chatgpt.mjs` 刷新重试） |
| **空 delta 还去灌 ChatGPT** | `delta.md = "_（无 DELTA 项）_"` 还走 CDP | 无短路逻辑 | ✅ `runArchitect` 入口 `if (!/DELTA-\d{3}/.test(delta)) { 本地写占位; return }` |
| **ChatGPT 配额耗尽** | "文件/图片/数据分析功能将于 7:51 重置" | 反复空跑测试灌 ChatGPT | **严禁**重复测试；冒烟用 fixture；正式只跑 1 次；配额耗尽 = 环境问题，非代码 bug |
| **reviewer 正则提取失败** | `verdictLines=0` 但 `textLen>0` | verdict 表非竖线分隔 / marker 后缀未匹配 | `extractVerdictLines` 已兼容 `\t`/空格；marker 后缀已加 `#dispatch=` 防自杀 |
| **去重误拦** | `historyHasSha` 拦截同 artifact 重跑 | `DISPATCH_FAILED/ABORTED` 行不以 sha 开头 | ✅ history 写入区分 `DISPATCH_FAILED/ABORTED` 前缀，去重只匹配 `<sha> ` 开头 |
| **附件态点了发送但没发**（deepseek/chatgpt，2026-10-08 实测） | 输入框 prompt 还在、无新气泡 | deepseek 按钮被吞；chatgpt 合成 Enter（enter-only 防双发）在附件态不触发 | ✅ 提交确认升级重试：提交 1.5s 后输入框残余>0 → 换方式再发（enter↔button）；chatgpt 兜底按钮 `button[data-testid="send-button"]`（buildSubmitScript(reviewer, mode)） |
| **弱回复无意义 / 回空 []**（网页席；历史实测 grok/chatgpt） | 有效 findings=0 | 模型偷懒 + 小探针文件；重发整轮浪费配额 | ✅ 质量门 regenGate（0 条 severity+title 合法项）→ 悬停最后一条回复（chatgpt 工具栏 hover 才渲染，mouseMoved 后再点）→ 点刷新（grok="Regenerate"，选择器须含 role=menuitem/option、label 读父级 aria；qwen 刷新文案待探，未探到就同页重发兜底）；找不到按钮才同页重发兜底，maxRegen=1 |
| **prompt 写"无问题输出 []"** | 网页席直接回空数组（历史实测 grok/chatgpt） | 该句诱导空回复（用户实测拍板删除） | ✅ buildWebScanPrompt 只给简短描述 + JSON 契约（type/severity 枚举），禁写空输出诱导句 |
| **architect 段缺 upload 字段** | runTabUpload 拒跑 chatgpt 席 | reviewers.yaml architect 段只有 editor_selector | ✅ architect 段补 `upload_strategy: direct` + `file_input_selector: 'input[type="file"]'`（role 三席已有） |
| **扫描整文件内联 prompt** | 网页席超长/质量差 | 本地席与网页席共用全文 prompt | ✅ 扫描走附件通道：完整文件 + 简短描述 prompt（orchestrate `buildWebScanPrompt`，webSeatRunner 传 `runTabUpload`） |
| **ChatGPT 回复真实存在但 raw md=136B 空壳**（T-58 实测，2026-10-13） | upload ok=true、user 手动看到完整回复，但 `raw\chatgpt.md` 只有 URL+Title 头部、无 Response 正文；`chatgpt-log.json` 里 `editorState.textLen=1、containsMarker=false`，phase 到 `response-timeout` 截断 | 两个独立缺陷叠加：①ProseMirror 编辑器注入机制几乎失败（textLen=1，marker 没进正文）；②`buildSnapshotScript` 硬编码 response selector 列表无一条命中 chatgpt 新 UI 的消息 DOM，`afterMarker` 通道也因 marker 缺失而废——capture 两头都瞎，`waitForResponse` 打满 `TIMEOUT_UPLOAD_BASE_MS=300s` 后按空壳落盘 | ⚠️ 已定位根因，**修复已落地（T-62 三通道齐修，2026-10-14，commit 7d73798）**（原排期注记见遗留项.md）：需在 `reviewers.yaml` 加 `response_selector` 字段（per-seat 可覆盖）+ 修 ProseMirror 注入（execCommand/insertText 而非 innerText 直写）；修复后如再遇空壳，兜底：chatgpt 席 raw md 空壳时**必须手动到 UI 截取回复正文**（已在 scan-mv6891vj 会话里验证过 12 条 findings 真实存在），不能因空壳判定席位死或浪费一轮重跑 |

---

## 6. 环境基线（不可变，变了要重新基线）

| 项 | 基线值 |
|----|--------|
| Chrome 版本 | Chrome/153.0.8010.12（playwright chromium-1243） |
| CDP 端口 | 127.0.0.1:9222（`--remote-debugging-port=9222 --remote-debugging-address=127.0.0.1`） |
| 持久 profile | `<workspace>\chrome-cdp-profile`（含登录态、验证 Cookie） |
| 启动器 | `orchestrator/启动 CDP 浏览器.bat`（桌面快捷入口 `%USERPROFILE%\Desktop\CDP浏览器.bat`，两份内容同步） |
| reviewer tabs | Gemini / DeepSeek / Grok / ChatGPT 均已登录、保持打开（席位名单唯一事实源 = reviewers.yaml enabled:true；2026-10-14 qwen 服务器宕机 → 用户指令换回备胎 grok 并实探定配（editor=div.tiptap.ProseMirror / submit=button[aria-label="Submit"] / response_selector=.message-bubble.rounded-3xl），qwen 恢复后重评再切。ChatGPT 兼 architect 席，url_match `chatgpt\.com`） |
| 网页席附件配额（2026-10-14 用户拍板） | **ChatGPT 带附件问询每日 3 次**（支持 .zip，≤512MB；单会话≤20 文件）；**Gemini 单会话≤10 文件**（skip_fresh_chat 复用页时额度被多轮分摊，第 11 个前导航新会话）；**DeepSeek 不支持 .zip**（发原始文件或 inline）；其余席位不限。派单纪律：小 artifact（<20000 字符）走 inline=零消耗；消耗 chatgpt 附件配额的 dispatch 须按 3/日记账 |
| thresholds | `blind_spot_to_delta: HIGH; single_reviewer_to_delta: HIGH; single_reviewer_to_backlog: [LOW,MEDIUM]` |
| filters | 5 条 ruleId（ABSOLUTE-PATH / RUNTIME-ID / OUT-OF-SCOPE / LINE-LENGTH / MISSING-COMMENT） |

> ⚠️ 任何基线项变更（升级 Chrome、换 profile、改 thresholds） → **必须**重跑全回归 + 全链路冒烟。

**`.bat` 编码铁律（2026-09-30 实测踩坑）**：
- cmd 解析 bat **必须 CRLF 行尾**——LF-only 会让 `^` 续行断裂，后续行被当独立命令拆碎执行。
- 含中文的 bat 必须 **GBK/cp936 编码**——write 类工具默认产出 UTF-8，直接落盘中文注释/echo 全乱。
- 验证法：`cmd /c "chcp 936>nul & <bat>"` 跑一遍，无 `'xxx' is not recognized` 即解析正常（双击 = 新控制台 936，与此等价）。

---

## 7. 验收报告模板（交付物）

每次正式验收后，产出一份 `reviews/<dispatchId>/ACCEPTANCE_REPORT.md`（模板）：

```markdown
# 四方会诊验收报告

dispatchId: <id>
artifact: <path>
timestamp: <ISO>
环境基线: Chrome <ver> / CDP 9222 / profile <path>

## 结果摘要
- Dispatch: OK / FAIL (dispatchId)
- Reviewer: gemini OK(textLen=X) / deepseek OK(Y) / qwen OK(Z)
- Analyze: issues=N, conflicts=C, blind_spots=B, backlog=BK, deltas=D
- Architect: inject OK / submit OK / formatOk=T/F / captured chars=L

## 证据链
- layer-a/raw/*.md  (textLen > 0)
- layer-b/delta.md  (deltas 列表)
- layer-b/architect-decision.md (真实裁决，非占位)

## 异常记录
- 无 / 见下文
```

---

## 8. 禁忌清单（红线，违者回滚）

- ❌ 空 delta / 占位 delta 走 CDP（必须短路）
- ❌ 未清挑战直接派单（必须预检）
- ❌ 重复向 ChatGPT 灌测试 prompt（严禁重复测试消耗配额）
- ❌ 修改 `orchestrator/orchestrate.mjs` 未跑回归基线
- ❌ 修改 `reviewers.yaml` 未跑 `yaml_check`（18/18）
- ❌ 未登记台账直接改代码（R1 违规）
- ❌ 自己验收自己改的代码（R4 违规，需二客户端交叉验证）

---

## 9. 版本记录

| 版本 | 日期 | 变更 | 作者 |
|------|------|------|------|
| v1.0 | 2026-09-30 | 首版：固化 T-01 全链路踩坑 | deepseek-harness |
| v1.1 | 2026-10-12 | 席位同步：grok→qwen（T-57 换座；席位名以 reviewers.yaml enabled 为准）| opencode |

---

> **核心原则**：环境先行、链路自检、空短路、非重复、证据可查。违者回滚，不讲情面。