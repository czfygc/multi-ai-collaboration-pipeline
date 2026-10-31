---
name: titan-plugin-mining
description: "【工具链】只挖插件与技能：梳理 cursor/plugins（.cursor-plugin 规范）与 claude-plugins-official（skills/commands）结构、许可与映射，不 vendor 第三方原文，入库前逐个读 LICENSE。触发词：挖插件 / 挖技能 / plugin mining"
version: 1.1.0
requires: none
tests: node --test orchestrator/test/skill-manifest.test.mjs
provenance: original
---

# T-148 插件/技能挖掘记录（cursor/plugins + claude-plugins-official）

## 0. 来源与抓取约束

- 来源 repo：`cursor/plugins`、`anthropics/claude-plugins-official`（GitHub 官方源，T-149 报告 design-specs/github-opensource-borrowing-review-20261021.md §9.1 已记录 URL，此处不再猜测）。
- 抓取方式：raw README（webfetch 读取，2026-10-21）。
- 硬约束：GitHub REST API 对本 IP 已限流 403（T-143 结论），**不能 `git clone` 整个 repo，不能批量读取每个 plugin 的 LICENSE，不能运行桌面安装器（M5 禁手）**。审查结论以 README 为准，并标注"待逐 plugin 读 LICENSE 最终确认"。
- 不装 Claude Code 客户端、不做 CLI 冒烟对照（2026-10-21 用户拍板选 B）。

## 1. cursor/plugins（跨客户端插件规范，P1）

| 项 | 内容 |
|---|---|
| 许可 | README 声明 **MIT**（需读仓库 LICENSE 文件最终确认，因 API 限流未取得） |
| 结构 | 根 `.cursor-plugin/marketplace.json` 列出全部 plugin；每个 plugin 独立目录，内含 `.cursor-plugin/plugin.json`（per-plugin manifest）、`skills/`（SKILL.md + frontmatter）、`rules/`（.mdc 规则）、`mcp.json`（MCP 服务器定义）、README/CHANGELOG/LICENSE |
| 技能模式 | `skills/` 下每个技能一个目录，含 `SKILL.md`，带 frontmatter（name/description 等），与 V2 `.agents/skills/*/SKILL.md` 格式高度对齐 |
| 与 V2 映射 | V2 已有 `SKILL.md` + `registry.json` + `categories.json`，与 cursor/plugins 的 `skills/` + `SKILL.md` + frontmatter 可直接对齐，无需运行时隔离（V2 无 Claude Code hooks/agents/权限系统，那些不可移植） |
| 借鉴建议 | 采用 `plugin.json` + `skills/` + `rules/` + `mcp.json` 四层结构作为 V2 技能发布/版本化的参考模板（见后续 T-151 候选 SKILL_MANIFEST.json） |

## 2. claude-plugins-official（Anthropic 官方插件目录，P2，仅设计参考）

| 项 | 内容 |
|---|---|
| 许可 | **仓库无单一 license**，"Please see each linked plugin for the relevant LICENSE file"，各 plugin 各自许可，需逐个确认 |
| 结构 | `plugins/`（Anthropic 内部）+ `external_plugins/`（第三方）；每个 plugin 含 `.claude-plugin/plugin.json`（元数据，必填）、`.mcp.json`（MCP 配置，可选）、`commands/`（斜杠命令，可选）、`agents/`（Agent 定义，可选）、`skills/`（技能定义，可选）、README.md |
| 关键机制 | `name` 为 immutable slug，发布后不可改名；重名迁移通过顶层 `.claude-plugin/marketplace.json` 的 `renames` 映射；skill-bundle 插件可用 `strict: false` + 显式 `skills` 数组 + `git-subdir` 来源（url/path/ref/sha），每个技能注册为 `<plugin-name>:<skill-name>` |
| 与 V2 映射 | V2 `.agents/skills/` 已是按名字目录组织的技能集，与 `skills/` + `SKILL.md` 模式兼容；`commands/` 可改写为 V2 技能；`.mcp.json` 可映射到现有 MCP 配置；`agents/`/`hooks/`/`permissions` 是 Claude Code 运行时特性，**不可移植** |
| 借鉴建议 | 借鉴 immutable slug + renames + skill-bundle（git-subdir+sha 锁定版本）的版本化思想；不直接搬 external_plugins 内容（第三方插件各自许可未知） |

## 3. M5 许可与密钥审查（入库前必须）

1. `cursor/plugins`：README 标 MIT，**必须**在入库前读取仓库 LICENSE 文件逐字核对（README 与实际 LICENSE 可能不一致，T-149 报告 §9.2 第 4 条）。GitHub API 限流前未取得 LICENSE，此处标 **待确认**。
2. `claude-plugins-official`：仓库级无单一 license，**必须**逐 plugin 读取其 LICENSE 文件，仅许可兼容（MIT/Apache-2.0/BSD 等宽松许可）的 plugin 才允许借鉴结构；AGPL/GPL 等传染性许可的 plugin 禁止借鉴代码/技能原文。
3. 密钥：抓取过程未涉及任何密钥/令牌，`titan_secrets.env` 未动，命令行未出现密钥（M5 第 3 条满足）。
4. 安装底线：本次不安装任何客户端/插件/二进制（只读 README），不违反 M5 第 1、2 条。

## 4. 与 V2 `.agents/skills/` 的现状对比（2026-10-21）

- 现有技能目录（18 个）：titan-cdp-browser-ops、titan-claw-connector、titan-cleanup、titan-code-review、titan-cross-session-memory、titan-diagnosing-bugs、titan-four-party-consult、titan-grilling、titan-handoff、titan-headless-clients、titan-multi-review-dispatch、titan-publish-sync、titan-quant-tool-discipline、titan-registry-edit、titan-review-channels、titan-search-then-interrogate、titan-tdd、diagram-design、router。
- 索引文件：`registry.json`（skills 数组，name/category/description/triggers/keywords/alwaysAttach/payload）、`categories.json`（分类→skills 映射）。
- 缺口（对应 T-149 报告 §六 完整性判定）：无跨客户端插件 manifest、无技能发布版本化、无 SKILL_MANIFEST.json。cursor/plugins 的 `plugin.json` + `mcp.json` + `skills/` 四层结构可作为补齐该缺口的参考（后续 T-151 候选）。

## 5. 入库建议（T-148 产出）

- **不直接 vendor** cursor/plugins 或 claude-plugins-official 的任何技能原文/命令代码，避免版权与许可风险。
- 本文件作为 T-148 的挖掘记录与 M5 审查结论入库 `.agents/skills/titan-plugin-mining/SKILL.md`。
- 后续若需把跨客户端 manifest 变成可执行功能，另开 T-151（`SKILL_MANIFEST.json` + orchestrator 解析注册），并在此基础上补齐每个借鉴 plugin 的 LICENSE 核对记录。

## 5.1 T-151 落地（2026-10-21，承接本文件 §1/§2 的规范）

- 规范已落地为 `.agents/skills/SKILL_MANIFEST.json` + 生成器 `orchestrator/skill-manifest.mjs`：
  - 字段：`name` / `slug`（immutable 标识）/ `version` / `source`（provenance 拆解 kind/origin/ref）/ `sha256`（SKILL.md 内容哈希）/ `treeSha256`（技能目录内容哈希）/ `entrypoints`（文件清单）/ `readOnly`（默认 true，frontmatter 写 `write: true` 才记 false）/ `requires` / `tests` / `provenance`。
  - **只读生成器**：只扫 `.agents/skills/*/SKILL.md`，不碰技能正文；**不改目录式发现方式**（`.agents/skills/*/SKILL.md` 仍是唯一发现入口，manifest 只是并行事实源）。
  - **内容寻址 + 并发冲突显式失败**：`apply` 用 `orchestrator/lib/lock.mjs` 的单写者锁 + baseSnapshot 比对；`--expect-sha256` 做 CAS 期望值校验，不符即拒写（不静默覆盖他端改动）。
  - 四个子命令：`status`（只读差异）/ `build`（预演，默认不落盘）/ `apply`（落盘）/ `verify`（校验与磁盘一致）。
  - 字段来源：frontmatter 六字段沿用 T-155 技能质量门（`node orchestrator/skill-quality.mjs --strict` 仍是技能准入门）。

## 6. 验收

- M2 由非作者客户端（Kilo，降级 Cline）复核本文件；证据落 `archive/evidence/T-148/`。
