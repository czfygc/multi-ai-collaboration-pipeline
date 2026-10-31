---
name: titan-four-party-consult
description: "【评审复核】4 会诊 / 多方独立复核：两种模式——①管道模式（Gemini/DeepSeek/Qwen 走 CDP 审 artifact + ChatGPT 做 Architect）②复杂问题 4 席同题交叉审问（deepseek/qwen/gemini/chatgpt 四网页席一次全问）。无损保留原始发现、检测冲突与盲区，产出决策输入（作者用完汇总）。触发词：4 会诊 / 四方会诊 / 交叉审问 / cross-examine / multi-review / cross-model review / 复杂问题问四家"
user-invocable: true
model-invocable: true
version: 1.1.0
requires: cdp-browser-9222, reviewers.yaml
tests: "manual: 对一份 fixture 报告跑四席会诊并检查 delta.md"
provenance: original
---

# TITAN 4 方会诊协议 (Four-Party Consult)

## 触发条件

当用户说出以下任意表述时，启用本 Skill：

- "要 4 方会诊" / "4 方会诊" / "四方会诊"
- "多模型会诊" / "cross-model review" / "multi-review dispatch"
- "让几个 AI 一起审一下" / "交叉审计这份 artifact"

启用后，Harness 按本协议全程自动执行：环境检测 → 分发 → 收集 → Layer A → Layer B → ChatGPT 裁决 → 停止。不要求用户手动开 Chrome、开 tab、跑命令。

## Architectural role model (READ FIRST)

"4 方" = 3 位独立 Reviewer + 1 位 Research Architect（ChatGPT）。

    Independent Reviewers (parallel dispatch)
    ├── Gemini     — 架构与接口契约
    ├── DeepSeek   — 正确性与实现细节
    └── Qwen       — 对抗性与失效模式
            ↓
    [Harness aggregation]
            ↓
    Layer A: aggregated-feedback.md   (lossless)
            ↓
    Layer B: delta.md                 (architect input)
            ↓
    ChatGPT — Research Architect      (第四方)
            ↓
    Director
            ↓
    Execute → Verify → (re-dispatch with parent lineage if needed)

ChatGPT is NOT a reviewer. It is the fourth party (Research Architect) that consumes delta.md and produces architect-decision.md for Director.

> 席位名单唯一事实源 = `orchestrator/reviewers.yaml`（enabled:true 生效）。2026-10-12 T-57 起现役 = **gemini / deepseek / qwen**（grok `enabled:false` 备胎，导航超时+强模型收费已换座）。本技能内任何具体席位名仅作示例，派单前以 yaml 为准。

## Mode 2：复杂问题 4 席同题交叉审问（2026-10-22 用户裁定 · 8 个月失败开发总结）

> 用户原话："chat.deepseek.com，chat.qwen.ai，gemini.google.com，chatgpt.com，
> 复杂的问题你直接把他们4个一起交叉审问 能解决99.9%的问题——这是我经过8个月开发失败后总结的经验。"
> 落盘：共享记忆 fact `76c69332`（decision）。

**与 Mode 1（管道模式）的区别**：管道模式审的是**一份 artifact**（layer-a/b/delta 结构化流水）；
Mode 2 审的是**一个问题**（方案/难 bug/架构决策/收口复核），四席同题直问，不经 pipeline 层。
两者可叠用：先 Mode 2 定方向，再 Mode 1 做 artifact 级裁决。

**四席固定（缺一即不成立）：**

| 席 | 入口 | 本席价值 |
|---|---|---|
| chat.deepseek.com | 网页 | 正确性与实现细节（逐行抓真 bug） |
| chat.qwen.ai | 网页 | 对抗性与失效模式 |
| gemini.google.com | 网页 | 架构与接口契约 |
| chatgpt.com | 网页 | 架构视角 + **跨会话记忆**（复核落点；同题可复用历史上下文） |

**执行红线（违反即判复核未完成）：**

1. **同题同料**：四席发**同一份**问题单（同一 brief 文件、同一证据摘录），不许给某席"更多背景"——否则发现不可比，冲突检测失效。
2. **一次四席并行**：不许"先问一家看结论再决定要不要问别家"；也不许只问 1~2 席就下"复核通过"结论。
3. **无损保留**：各席原始回复整段落盘到 `archive/evidence/<T-xx>/web/<seat>.md`，去重分析是**第二步**，第一步永不改写原文。
4. **单席失败必须补位**：某席上传失败/挑战页/超时 → 补位重发，缺口显式标注；**单席结论 ≠ 复核完成**（本轮 T-168 实证：DeepSeek 抓 3 条、ChatGPT 抓 5 条 P1，互为盲区）。
5. **发现逐条核验后才算数**：每条发现先本地核验真假再改代码（假发现照样浪费一轮），核验结论回写证据文件。
6. ChatGPT 席可调**两次不同角色**（咨询席 + 架构席，见 `reviewers.yaml` 的 `role: consultant` 与 `architect:`），保留该机制。

**完成判据**：四席齐 + 无损归档 + 逐条核验（真→修+回归、假→注明）+ 冲突/盲区汇总一份。

## Scope

Defines the protocol for dispatching a TITAN artifact to independent reviewers, collecting outputs, normalizing findings without information loss, detecting conflicts and blind spots, and producing two layers of decision-grade material.

Does NOT define P0/P1 semantics, event certification, phase gates, or trading decisions. Those remain governed by TITAN canonical specifications.

## Protocol overview

    INPUT
      ↓
    [1]  Define review target        (artifact path + SHA256)
    [2]  Load reviewer registry      (reviewers.yaml, enabled:true)
    [3]  Load dispatch lineage       (parentDispatchId, reviewRound, trigger)
    [4]  Freeze artifact             (SHA256 snapshot; abort on drift)
    [5]  Independent dispatch        (parallel, isolated, no cross-contamination)
      ↓
    [6]  Collect raw                 (layer-a/raw/<reviewer>.md + screenshots)
    [7]  Normalize                   (structured ISSUE extraction per reviewer)
    [8]  Canonical grouping          (NOT destructive deduplication)
    [9]  Cross-reference             (occurrences map back to reviewer ISSUE-IDs)
    [10] Conflict detection          (FACT_CONFLICT / ASSUMPTION_CONFLICT)
    [11] Blind-spot classification   (severity-gated elevation)
    [12] Filter audit                (record, never silently drop)
      ↓
    [13] Layer A: aggregated-feedback.md + issues-normalized.json
         Layer B: delta.md + conflicts.json + blind-spots.json + filtered.json + backlog.json
      ↓
    ChatGPT (Research Architect / 第四方) → architect-decision.md
      ↓
    Director → Execute → Verify → (re-dispatch with parent lineage if needed)

Steps [1]–[5] are mechanical (orchestrator). Steps [6]–[13] are analytical (Harness).

## Two-layer output (mandatory separation)

### Layer A — aggregated-feedback.md + issues-normalized.json

Purpose: preserve reviewer signal losslessly enough for audit and re-analysis.

Must contain, per reviewer:
- Reviewer name
- Review ID (dispatchId-scoped)
- Timestamp
- Perspective applied (verbatim from reviewers.yaml)
- ISSUE-ID (as emitted by reviewer)
- Original finding text (verbatim)
- Evidence cited (quoted from reviewed artifact)
- Severity (as self-declared)
- Raw response path + SHA256

Must NOT:
- drop findings deemed "minor"
- rephrase reviewer text in the raw section
- collapse findings before Layer A is complete

### Layer B — delta.md + companions

Purpose: architect-grade decision input. Everything that requires human or architect judgment.

Eight-bucket classification (each normalized issue lands in exactly one):

| Bucket | Rule | Destination |
|---|---|---|
| CONSENSUS | ≥2 reviewers, same factual proposition, same evidence scope | Correction list |
| COMPLEMENTARY | Different reviewers, different angles, no contradiction | Perspective improvement list |
| BACKLOG | Exactly 1 reviewer, self-rated LOW or MEDIUM | Review backlog (NOT delta) |
| HIGH_SEVERITY_UNCONFIRMED | Exactly 1 reviewer, self-rated HIGH, below blind-spot threshold | DELTA |
| FACT_CONFLICT | ≥2 reviewers, different verdicts on same fact | DELTA |
| ASSUMPTION_CONFLICT | Reviewers reasoned from incompatible premises | DELTA |
| BLIND_SPOT | Exactly 1 reviewer, others silent, severity ≥ threshold | DELTA |
| FILTERED | Matches a known-misclassification filter rule | Recorded in delta "Filtered findings" section, not acted upon |

Severity thresholds configurable via reviewers.yaml → thresholds:
- Default: `blind_spot_to_delta: HIGH`, `single_reviewer_to_delta: HIGH`
- BLIND_SPOT + MEDIUM/LOW → backlog, NOT delta
- SINGLE_REVIEWER + MEDIUM/LOW → backlog, NOT delta
- This prevents the architect from being flooded with minor single-reviewer noise.

DELTA entry template:

    ### <DELTA-ID>
    Type: FACT_CONFLICT | ASSUMPTION_CONFLICT | BLIND_SPOT | HIGH_SEVERITY_UNCONFIRMED
    Reviewers:
      - gemini   : <verdict or "not raised">
      - deepseek : <verdict or "not raised">
      - qwen     : <verdict or "not raised">
    Occurrences:
      - { reviewer: gemini,   issueId: G-04, severity: HIGH }
      - { reviewer: deepseek, issueId: D-06, severity: HIGH }
    Finding (verbatim, shortest reviewer wording):
    Evidence:
      - <quoted line + reviewer source>
    Same-fact verification:
      - artifact: <same artifact SHA256>
      - factual proposition: <one sentence>
      - evidence scope: <what part of the artifact>
    Requires Architect decision:
      - <precise question>
    Suggested action:
      - revise artifact | accept risk | re-dispatch with new perspective | escalate

## Canonical grouping (NOT destructive deduplication)

Critical rule: never delete reviewer original ISSUE-IDs.

Pipeline position: Layer A (`--dispatch`) emits **one canonical issue per reviewer
finding, each carrying exactly one occurrence** — no cross-reviewer merge yet.
Cross-reviewer grouping (same artifact + same proposition + same evidence scope)
happens in Layer B (`--analyze`), which consumes the per-reviewer canonical lists
and produces the eight-bucket classification. Layer A must stay merge-free so
that no reviewer finding is silently folded away before conflict detection runs.

Normalized structure (Layer A, one occurrence per issue):

    {
      "canonicalIssueId": "F-001",
      "factualProposition": "Screenshot evidence lacks stage mapping",
      "evidenceScope": "screenshot-evidence-table",
      "occurrences": [
        { "reviewer": "gemini",   "issueId": "G-05", "severity": "MEDIUM" },
        { "reviewer": "deepseek", "issueId": "D-09", "severity": "MEDIUM" }
      ]
    }

Merge is permitted ONLY when all three conditions hold:

1. Same artifact — identical artifact SHA256
2. Same factual proposition — the claim being asserted is identical, not just the topic
3. Same evidence scope — the same part of the artifact is being cited

If two findings share only a topic (e.g., "screenshot issues") but assert different propositions (e.g., "missing stage mapping" vs "missing timestamp"), they are COMPLEMENTARY, not CONSENSUS.

Example of false-consensus trap:

    Gemini:   "截图缺少阶段映射"          → proposition A
    DeepSeek: "截图缺少 timestamp"        → proposition B
    Qwen:     "截图无法证明来自实时 CDP"  → proposition C

Same topic (screenshot evidence), but three different propositions → COMPLEMENTARY, not CONSENSUS.

## Dispatch lineage (mandatory)

Every dispatch carries:

    {
      "dispatchId": "a13f92c4",
      "parentDispatchId": null,
      "reviewRound": 1,
      "trigger": "DIRECTOR_REQUEST | ARCHITECT_REVIEW_REQUEST | REMEDIATION_VERIFICATION | MANUAL",
      "artifactPath": "<workspace>\\reports\\TASK-2-FINAL-REPORT.md",
      "artifactSha256": "<64-hex>",
      "timestamp": "2026-09-25T...Z"
    }

- `parentDispatchId` = the dispatch that produced the artifact version under review (null for originals)
- `reviewRound` = monotonic integer starting at 1
- `trigger` = why this dispatch was launched

This enables full traceability: which round introduced an ISSUE, which round fixed it, which round closed it.

## Filter audit (record, not delete)

When a finding matches a known-misclassification filter rule, do NOT silently drop it.

Record:

    {
      "reviewer": "gemini",
      "issueId": "G-04",
      "classification": "FILTERED",
      "reason": "runtime identifier is required chain-of-custody evidence",
      "ruleId": "FILTER-RUNTIME-ID-001"
    }

And in delta.md, add a section:

    ## Filtered Findings (recorded, not acted upon)

    | Reviewer | Issue-ID | Rule | Reason |
    |---|---|---|---|
    | gemini | G-04 | FILTER-RUNTIME-ID-001 | Runtime identifiers are chain-of-custody anchors |

Future auditors must be able to answer: "where did G-04 go?"

## Execution rules

### SOP gate（派单前必过闸 — T-03 挂载）

> 详版坑库/验收报告模板：`<workspace>\.agents\skills\titan-four-party-consult\四方会诊_SOP.md`（canonical，与本文件同目录）。
> 本节是随技能注入的执行核心，与该文件**双向同步**：改任何一边必须同步另一边并提交。

**前置检查（全过才准派单；任一不过 = 先修环境，不派单）：**

1. CDP 可达：`http://127.0.0.1:9222/json/version` → 200。
2. Chrome 带持久 profile：`--user-data-dir=<workspace>\chrome-cdp-profile`（登录/验证态跨重启保留）。
3. `/json/list` 中 Gemini / DeepSeek / Qwen 三个 `type=page` tab 全部在线且已登录（席位名单以 reviewers.yaml enabled:true 为准）。
4. ChatGPT tab **非挑战页**（title ≠ "Just a moment..."、url 无 `__cf_chl_`）；存疑先跑 `<workspace>\.agents\skills\titan-four-party-consult\tools\_probe_chatgpt.mjs`。
5. `reviewers.yaml` thresholds 未漂移（`blind_spot_to_delta`/`single_reviewer_to_delta` = HIGH）。
6. 改过代码 → 先跑回归：`--analyze 66c0f00e` + `_fixture_stest2`，断言须与 `_session_memory.md` 第 2 节完全一致。
7. 轻量冒烟（推荐）：`--analyze _fixture_stest2` 秒级验证分析链，不消耗任何外部配额。

**标准链式命令（一次跑完 dispatch → analyze → architect，不拆段执行）：**

    cd <workspace>\orchestrator
    node orchestrate.mjs --review <artifact-path> --analyze --architect

**执行红线（违反即停止并回滚，详见 Forbidden）：**

- 任一 reviewer `textLen=0` → 本次判失败，**禁止**进入 analyze/architect，先修捕获层（常见根因：Node 函数泄漏进浏览器模板 → `ReferenceError: markerEnd`）。
- delta 无 `DELTA-###` → 走本地短路，**严禁**空/占位 delta 发 CDP 或灌 ChatGPT。
- **严禁**重复向 ChatGPT 灌相同测试 prompt（配额是资源；冒烟用 fixture，正式验收只跑一次）。
- fresh-chat 撞挑战页 → 先 `<workspace>\.agents\skills\titan-four-party-consult\tools\_try_turnstile.mjs` 清一次；未清不准原样重试。
- artifact 中途变更（sha 漂移）→ `DISPATCH_ABORTED`；修复后以**新 sha 重派**，不复用旧 dispatch。

### Pre-dispatch

1. Confirm CDP endpoint reachable: `http://127.0.0.1:9222/json/version`.
2. If unreachable: do NOT auto-start Chrome. Instruct user to run `<workspace>\orchestrator\启动 CDP 浏览器.bat` (persistent profile keeps login/verification state).
3. Compute artifact SHA256. Check `dispatch-history.log`. If same SHA256 already dispatched, warn and require explicit override.
4. Load `reviewers.yaml`. Confirm all enabled reviewer tabs are open and logged in.
5. Record artifactSha256 before dispatch. If it changes during dispatch → `DISPATCH_ABORTED`.

### Dispatch

Invoke orchestrator with fixed interface:

    node <workspace>\orchestrator\orchestrate.mjs --review <artifact-path> \
      [--round <N>] [--parent <dispatchId>] [--trigger <TRIGGER>]

Orchestrator writes to:

    <workspace>\reviews\<dispatchId>\
      layer-a\
        raw\<reviewer>.md              (verbatim, SHA256-stamped)
        screenshots\<reviewer>.png
        issues-normalized.json         (canonical grouping, lossless)
        aggregated-feedback.md         (Layer A)
        dispatch-meta.json             (lineage + config)
      layer-b\
        conflicts.json
        blind-spots.json
        filtered.json
        backlog.json
        delta.md                       (Layer B)

### Post-dispatch (Harness analytical work)

Read `layer-a\aggregated-feedback.md` and `layer-a\issues-normalized.json`.

Classify every normalized issue into exactly one bucket (see table above). Write:

- `layer-b\conflicts.json` — FACT_CONFLICT + ASSUMPTION_CONFLICT nodes
- `layer-b\blind-spots.json` — BLIND_SPOT nodes with severity
- `layer-b\filtered.json` — FILTERED nodes with ruleId
- `layer-b\backlog.json` — CONSENSUS + COMPLEMENTARY + BACKLOG + MEDIUM_SEVERITY_BACKLOG
- `layer-b\delta.md` — Layer B decision input for ChatGPT Architect

Critical: do NOT silently drop FILTERED items. They must appear in delta.md's "Filtered Findings" section.

### Architect handoff (第四方)

After delta.md is written, ChatGPT (Research Architect) consumes it and produces `architect-decision.md` in the same `layer-b\` directory.

### Stop condition

After `architect-decision.md` is written: stop. Do not generate supplementary reports, historical reconstructions, or consistency memos. Re-dispatch only if Director explicitly requests, using `--parent <previousDispatchId>` and `--round <N+1>`.

## Output discipline

- Do not copy full command outputs; cite key lines only.
- Do not restate reviewed artifact content; reference it.
- Reports use tables, not paragraphs.
- Full logs write to files under `reviews\<dispatchId>\`; never paste into session.
- DELTA target: < 3000 tokens.
- Layer A target: no artificial cap; verbatim preservation wins.

## Forbidden

- Adding ChatGPT to `reviewers.yaml` (it is the fourth party, not a reviewer).
- Modifying `orchestrate.mjs` or `reviewers.yaml` during a dispatch.
- Deleting reviewer original ISSUE-IDs in normalization.
- Merging same-topic-different-proposition findings into CONSENSUS.
- Silently dropping FILTERED findings.
- Elevating BLIND_SPOT with MEDIUM/LOW severity into DELTA.
- Elevating SINGLE_REVIEWER with MEDIUM/LOW severity into DELTA.
- Treating ASSUMPTION_CONFLICT as FACT_CONFLICT.
- Asking user to manually open Chrome / tabs / run commands when CDP is up.
- Letting reviewer A's prompt contain reviewer B's response.
- Modifying P0 / P1-A / RD.
- Stopping `E:\TITAN_RESEARCH`.
- Mass-migrating historical files during first deployment.
- Dispatching while any SOP gate pre-check fails (challenge page up, regression broken, reviewer tab logged out).
- Continuing into analyze/architect after `textLen=0` (silently absorbing capture failure).
- Feeding an empty or placeholder delta to ChatGPT (must short-circuit locally).
- Re-running identical ChatGPT prompts to "try again" (quota abuse; use `_fixture_stest2` for smoke).

## Self-check after dispatch (13 items)

Structural:
- [ ] `dispatch-meta.json` present; `dispatchId` is 8-hex
- [ ] `parentDispatchId` set correctly (null for round 1; else points to prior dispatch)
- [ ] `reviewRound` is monotonic integer
- [ ] `trigger` is one of the declared values

Reviewer identity:
- [ ] Each reviewer's URL / tab / session matches `reviewers.yaml` entry
- [ ] Each reviewer's perspective in `dispatch-meta.json` matches YAML
- [ ] Actual prompt sent to each reviewer contains that reviewer's `perspective_prompt` (not just different YAML — verify wire content)

Preservation:
- [ ] `aggregated-feedback.md` contains verbatim text for every reviewer
- [ ] `raw\<reviewer>.md` SHA256 matches the SHA256 recorded in `dispatch-meta.json`
- [ ] No content in `raw\<reviewer>.md` was modified by normalization

Isolation:
- [ ] No cross-review contamination: Gemini prompt did NOT contain DeepSeek/Qwen responses; DeepSeek prompt did NOT contain Gemini/Qwen responses; Qwen prompt did NOT contain Gemini/DeepSeek responses
- [ ] Artifact SHA256 unchanged from pre-dispatch to post-dispatch (else `DISPATCH_ABORTED`)

Analysis:
- [ ] `issues-normalized.json` uses canonical grouping; every original ISSUE-ID is preserved in `occurrences`
- [ ] Every normalized issue classified into exactly one of eight buckets
- [ ] At least one CONSENSUS node exists (if zero: reviewers likely not engaged)
- [ ] `delta.md` entry count = FACT_CONFLICT + ASSUMPTION_CONFLICT + (BLIND_SPOT with HIGH) + (SINGLE_REVIEWER with HIGH)
- [ ] FILTERED findings appear in `delta.md` "Filtered Findings" section with ruleId
- [ ] Artifact SHA256 appended to `dispatch-history.log` with dispatchId

## Deployment plan (three steps, not one-shot)

### STEP A — Infrastructure only

Change:
- `orchestrate.mjs` → `<workspace>\orchestrator\orchestrate.mjs`
- add `orchestrator\reviewers.yaml`
- add `reviews\`, `reports\`, `orchestrator\logs\`
- implement `dispatch-meta.json` with lineage
- write `layer-a\raw\` + `layer-a\screenshots\` + `issues-normalized.json`
- append `dispatch-history.log`

Do NOT implement DELTA logic yet.

Acceptance: 3 reviewers → 3 raw files + metadata + hash. No analytical layer.

### STEP B — Skill analytical layer

Add: canonical grouping, six-bucket classification, conflict detection, blind-spot severity gating, filter audit, backlog.

Acceptance:

Synthetic test 1 — construct artifact where:
- Reviewer A: PASS
- Reviewer B: FAIL
- Reviewer C: not mentioned
Must produce `FACT_CONFLICT`.

Synthetic test 2:
- A finds HIGH
- B/C silent
Must produce `BLIND_SPOT` (or `HIGH_SEVERITY_UNCONFIRMED`) in DELTA, NOT in backlog.

Synthetic test 3:
- A/B/C all mention "screenshot evidence" with different specific propositions
Must produce 3 COMPLEMENTARY nodes, NOT one CONSENSUS.

### STEP C — Real TITAN artifact

Run against a real TITAN report. Produce full Layer A + Layer B. Feed `delta.md` to ChatGPT (第四方 / Architect). Verify the architecture holds.

Do NOT migrate historical files until STEP C passes. Then archive old `orchestrator-runs\` → `reviews\legacy\` in a single clean move.

## Cross-skill note

Quantitative tool discipline remains governed by `titan-quant-tool-discipline`. When the reviewed artifact is a quant research output, that Skill governs adequate tool usage; this Skill governs how review is structured.
