---
name: titan-parallel-delegation
description: "【协作流程】大任务分给 4 客户端并行协作：按文件所有权切分（路径不重叠）、委派者不碰 git（只交文件）、作者≠验证者、派单前先探活目标模型（配额是真瓶颈）、两个本地坑（后台进程被杀 / Cline 独立 data-dir 的 providers.json 会被重置）。触发词：并行 / 委派 / 分给别的客户端 / 派活 / 协作"
user-invocable: true
version: 1.1.0
requires: node, git
tests: "manual: 跑一次并行分单（两单路径不重叠）并按协议收割归口"
provenance: original
---

# titan-parallel-delegation —— 多客户端并行协作（协调而不混乱）

> 完整版：`design-specs/multi-client-parallel-protocol-20261021.md`（含今日实证与数据）。
> 本技能是**可执行摘要**：拿来就能派单。

## 0. 先记住这句话

**并行的瓶颈不是协调，是模型配额。** 协调靠文件所有权分区就能解决；配额靠「派前探活 + 链序整顿」解决。

## 1. 五条铁律

1. **单一台账**：认领 = 提交（`ISSUE_REGISTRY.json`），先到先得。
2. **文件所有权分区**：每单在台账 `files` 写明独占路径；两单路径**不得重叠**。
3. **共享文件只归协调者**：`ISSUE_REGISTRY.json` / `AGENTS.md` / `orchestrator/verify-gate.mjs` / `orchestrator/test/SUITES.md` / CI。
4. **委派者不碰 git**：只交文件；协调者统一集成 + 过闸 + 提交。
5. **作者 ≠ 验证者**：谁写的谁不能自己验收（Kilo 交叉验证最省额度）。

## 1.1 五条纪律补丁（T-171，已落到台账字段，**别再靠自觉**）

| 纪律 | 一句话 | 台账字段 |
|---|---|---|
| **证据分级** | 亲验 / 本地自报 / 未验证 三档；`cross_validation=PASS` 只配 `firsthand` | `evidence_level` |
| **一次修正后停止** | 作者自己改到第 2 轮还没过 → 移交他人 | `fix_rounds` |
| **OUT_OF_SCOPE** | 任务卡写死禁止事项；命中即停手回报，不许顺手改 | `task_card.out_of_scope` |
| **阶段语义** | 代码 / 产物 / 发布三段**独立** PASS；代码过 ≠ 产物过 | `stage` + `stage_results` |
| **YAML 任务卡** | `scope` / `acceptance` / `out_of_scope` / `evidence_required` 四段式 | `task_card` |

```powershell
node orchestrator/edit-issue.mjs --id T-172 --evidence-level local_report --stage code `
  --stage-results '{"code":"PASS"}' --task-card card.json
node orchestrator/task-card.mjs T-172     # 打印 YAML 任务卡 + 纪律检查（0=OK / 1=有 issue）
node orchestrator/task-card.mjs --all      # 全台账扫一遍
```

任务卡 YAML 长这样（`scope`=做什么 / `acceptance`=怎么算过 / `out_of_scope`=不许碰 / `evidence_required`=交什么证据）：

```yaml
scope:
  - "建共享探针 + TTL 健康表"
acceptance:
  - "node --test orchestrator/test/model-health.test.mjs 全绿"
out_of_scope:
  - "不许改客户端模型配置"
evidence_required:
  - "贴原始输出，证据落 archive/evidence/T-172/"
```

## 2. 派单前必做：选档 + 探活（省 90s 废话 + 省稀缺额度的关键一步）

```powershell
# 一次命令拿到"此刻该派谁"：健康 → 档位 → 额度 → 能力 → 速度 的推荐序
node orchestrator/model-health.mjs --task mechanical        # 机械活：低档模型优先
node orchestrator/model-health.mjs --task bounded_code      # 边界实现：中档起步
node orchestrator/model-health.mjs --task architecture      # 架构/协议：只给强档
```

- 输出里 `healthy` 且档位匹配的模型才可派；`down` 直接排除，**`unknown` 不当可用**（探针没跑成≠能用）。
- 额度优先：优先派**不限量平台**（kilo/xkiro/septor 一类），把账号级日限额的通道（OpenRouter 免费档）省给强档。
- 需要工具的活：探针**实测**没出 `tool_calls` 的模型不进候选（目录登记不算数）。

兜底探针（需要自己发请求时）：

```powershell
node -e "fetch('http://127.0.0.1:3001/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+process.env.FREELLMAPI_API_KEY},body:JSON.stringify({model:'auto:titan',messages:[{role:'user',content:'Call ping({n:1}).'}],tools:[{type:'function',function:{name:'ping',description:'p',parameters:{type:'object',properties:{n:{type:'integer'}}}}}],max_tokens:2048})}).then(r=>r.text()).then(t=>console.log(t.slice(0,200)))"
```

- 200 且 `tool_calls` 有值 → 派。
- 429 / 503 / 超时 → **换模型**（`minimax/minimax-m3.1-flash:free` / `nvidia/nemotron-3-ultra-550b` / `radeon:MiMo-V2.6-Flash` 都是免费强档），别硬派。

## 3. 委派 prompt 骨架（照抄）

```
You are implementing <T-xx> in this repo at <workspace>.
CONTEXT       现状（读得懂即可）
TASK          交付物，逐条编号
HARD BOUNDARIES
              - 只能写 <独占路径>；其它一律不许碰（逐条列）
              - 不许任何 git 写操作（no add/commit/checkout/reset/branch/stash）
              - 不许删改既有文件（除非点名）
              - 不许加依赖、不许联网
STYLE         跟仓内现有代码一致；注释用 //（Node 24 不认 # 注释）；UTF-8
ACCEPTANCE    你必须自己跑并贴原始输出的验收命令（逐条）
DELIVER       结尾固定三行：VERDICT: PASS / FILES: ... / TESTS: ...
```

**两个实测细节**：① 明确写「Node 24 不认 `#` 注释」；② 明确写「贴原始输出」——否则委派会拿推理代替证据。

## 4. 怎么跑（重要）

- **前台跑**：本机后台进程（`Start-Process` / `Invoke-CimMethod`）会在命令结束后被清理链杀掉 → 委派要么前台，要么用能存活的方式。
- **Cline 隔离 data-dir**：`providers.json` 要**复制桌面 `~/.cline/data/settings/providers.json` 原文件只改 `model`**；手工拼的最小结构会被 Cline 重置成默认（去打 api.openai.com 报 "Incorrect API key"）。
- 命令模板：
  ```powershell
  $env:OPENAI_API_KEY = (Get-Content "$env:USERPROFILE\.cline\data\settings\providers.json" -Raw | ConvertFrom-Json).providers.'openai-compatible'.settings.apiKey
  $p = Get-Content -Raw prompt.txt
  & '<workspace>\cline-local\node_modules\@cline\cli-windows-x64\bin\cline.exe' $p --json --auto-approve true -P openai-compatible -c '<workspace>' --data-dir '<workspace>\tmp\cline-<id>\data'
  ```

## 5. 模型分工（2026-10-21 整顿后）

| 角色 | 通道 | 适合 |
|---|---|---|
| OpenCode（协调者） | 付费走 OpenRouter 直连；日常免费 `minimax/minimax-m3.1-flash:free` | 统筹、拆单、关键实现、集成、收口 |
| Cline（实现位） | freellmapi `auto:titan`（链首=minimax 免费强档） | 边界清晰的实现单 |
| Kilo（复核位） | 自己的免费模型 | M2 交叉验证、只读挑错 |
| Harness | freellmapi `auto:titan` | 长任务/第二视角 |

## 6. 什么时候别并行

- 路径会重叠 → 串行。
- 一单是另一单的前置（如 R3 依赖 R4 的配置）→ 先前置后并行。
- 目标模型不健康 → 串行 + 探活。
- 需要同一份上下文连续推理 → 串行。

## 7. 收割清单（协调者）

- [ ] 亲自读 diff（不只看委托方的自述）
- [ ] 补齐它常漏的：测试、收尾、错误路径
- [ ] 跑任务自带验收命令 + `node orchestrator/verify-gate.mjs`
- [ ] 非作者客户端复核 → `archive/evidence/<T-xx>/`
- [ ] 台账 done + 共享记忆落盘
