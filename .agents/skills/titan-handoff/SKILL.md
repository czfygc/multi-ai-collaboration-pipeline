---
name: titan-handoff
description: "【协作流程】把当前会话压缩成交接文档交给另一个代理或新会话：写什么、存哪、必做的 M3 纪律（提交 WIP 或把台账改回 todo/blocked、结论入共享记忆）。触发词：交接 / 写交接文档 / 换个会话继续"
user-invocable: true
version: 1.1.0
requires: none
tests: "manual: 把一次会话压成交接文档并核对要点齐全"
provenance: adapted:mattpocock/skills#unversioned-MIT
---

# TITAN 会话交接

把当前会话压缩成一份交接文档，让新会话不靠猜就能接着干。

来源：改写自 mattpocock/skills 的 `handoff`（MIT, Copyright (c) 2026 Matt Pocock），接入 TITAN 的 M3 中断纪律与共享记忆。

## 与 TITAN 流程的分工

| 事项 | 归属 |
|---|---|
| 任务状态 | 台账 `ISSUE_REGISTRY.json`（交接后仍以台账为准） |
| 中断纪律 | AGENTS M3：暂停前提交 WIP，或把台账改回 `todo`/`blocked`，禁止半成品悬空 |
| 跨会话记忆 | M7：收尾前 `titan_memory_remember` 落盘可复用结论 |
| 根目录纪律 | 交接文档不落仓库根（M2） |

## 动手前的 M3 检查（缺一不可）

1. **代码**：WIP 已提交（小步提交 + `[T-xx]` 前缀）；不能提交的说明原因。
2. **台账**：状态与事实一致——继续做就 `in_progress`，暂停就 `todo`/`blocked`，并写清阻塞点。
3. **记忆**：把"下个会话必须知道、但看代码看不出来"的结论写进共享记忆（事实/决定类，≤2000 字，打关键词标签）。
4. **现场**：后台进程已停或已记明 PID；一次性脚本已清理（M2）。

## 保存位置

- **默认**：系统临时目录（Windows `%TEMP%`）。交接文档是会话间的一次性载体，不入库。
- **需要另一个客户端在同一工作区接手**：放 `tmp/<T-xx>/HANDOFF.md`（`tmp/` 不属根目录公共文件），下个会话认领任务后读完即删。
- **禁止**：仓库根目录、`design-specs/`（那是长期设计文档，不是会话状态）。

## 文档必含内容

```markdown
# 交接：<任务号> <一句话目标>

## 当前状态
- 台账：<T-xx 状态 / owner / verifier>
- HEAD：<commit>
- 分支：<main 或 stage/xxx>
- 已完成：<可验证的成果，附 commit>
- 未完成：<具体差什么>

## 关键决定
<只写"为什么这么做"，不重复报告/规格里已有的内容；引用路径>

## 下一步（按顺序）
1. <动作> → 验证方式 → 证据放哪
2. ...

## 坑与禁忌
<本会话踩过的坑、试过但失败的路、不能碰的文件/命令>

## 证据与文档指针
<archive/evidence/T-xx/...、design-specs/...、提交号>

## 建议加载的技能
- titan-tdd / titan-diagnosing-bugs / titan-code-review / titan-grilling（按需）
- 其他：<titan-headless-clients / titan-registry-edit ...>

## 安全
<已脱敏；密钥位置用环境变量名指代，不写值>
```

## 写作纪律

- **不重复**：规格、报告、ADR、提交信息里已有的内容只给路径/URL，不复述。
- **可执行**：下一步必须带验证命令与证据落点，不能写"继续完善"。
- **脱敏**：密钥、密码、个人路径一律不写（M5/M7）；需要时写"见 `titan_secrets.env` 的 `XXX`"。
- **按用户参数裁剪**：用户说了下个会话要做什么，就围绕那个焦点写，删掉无关枝节。
- **一页为限**：超过一页说明你在搬运而不是压缩；把细节挪到证据文件里引用。

## 收尾

交接文档写完后：

1. 若文档在 `tmp/`，提交它（属于下个会话的输入），或明确告知用户"未入库"。
2. 在共享记忆里留一条指针：任务号 + 交接文档路径 + HEAD。
3. 向用户确认：台账状态、HEAD、下一步第一件事。
