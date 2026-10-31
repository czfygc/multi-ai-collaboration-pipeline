---
name: titan-quant-tool-discipline
description: "【量化】量化研究工具选型纪律：专用工具优先、点时一致性/样本质量/滚动 OOS/交易成本/Deflated Sharpe/参数敏感性；保留 UNKNOWN 并说明回退限制。触发词：量化 / 回测 / 因子 / IC / Sharpe"
user-invocable: true
version: 1.1.0
requires: quant-mcp
tests: "manual: 对一个点位检查题走专用工具优先流程"
provenance: original
---

# TITAN Quant Tool Discipline

## Scope

This Skill governs tool selection for TITAN quantitative research, backtesting, data validation, and research visualization. It does not define hypotheses, event definitions, certification criteria, evidence authority, P0/P1 semantics, trading decisions, or phase gates.

P0/P1 canonical specifications and evidence/audit requirements take precedence. Tool selection never creates research authority.

## Core rule

When a dedicated TITAN Quant tool directly matches the requested operation:

**USE THE DEDICATED TOOL FIRST.**

Do not silently replace it with `pwsh`, Python, `read`, `grep`, manual arithmetic, generic `quant_*` tools, or informal reasoning. A generic tool may supplement inspection, debugging, verification, or analysis, but must not replace an applicable specialist tool.

Use the minimum set of tools required by the user's actual request. Do not invoke every Quant tool for every task.

## Mandatory routing

### Point-in-time, look-ahead, and leakage

For point-in-time correctness, look-ahead bias, future-data leakage, feature timestamp validity, historical information availability, or leakage across train/test boundaries, use:

- `quant_data_pit`

Manual source inspection may supplement the result, but may not replace it.

### Series quality

For time-series integrity, timestamp ordering, continuity, alignment, missing observations, duplicate observations, or series-level structural quality, prefer:

- `quant_series_quality`

Use `quant_data_quality` for broader dataset-level checks. If both apply, do not silently skip the series-level check.

### Dataset and market-data quality

For missing data, invalid records, malformed observations, completeness, dataset quality, or basic market-data integrity, use or prefer:

- `quant_data_quality`

A broader pipeline may be used when the user explicitly requests an end-to-end workflow.

### Walk-forward and out-of-sample validation

For walk-forward validation, rolling train/test evaluation, repeated out-of-sample validation, temporal generalization, or parameter/model stability across sequential periods, use:

- `quant_walk_forward`

Do not substitute a manually written rolling loop, a first-half/second-half comparison, or a single train/test split.

### Realistic trading costs

When the request explicitly requires realistic trading-cost analysis, including fees, slippage, execution costs, market impact, cost sensitivity, or net-of-cost performance, use or explicitly invoke:

- `quant_trading_cost`

A backtest `feeRate` represents only one cost component and is not automatically equivalent to full trading-cost analysis.

### Deflated Sharpe

For multiple testing, strategy/data-mining bias, Sharpe inflation, selection bias, or deflated Sharpe, use:

- `quant_deflated_sharpe`

Do not substitute the ordinary Sharpe from `quant_metrics` when multiple-testing or selection effects are the question.

### Parameter sensitivity

For parameter robustness, sensitivity, stability across parameter values, or identifying isolated parameter peaks, use:

- `quant_parameter_sensitivity`

Do not substitute a single nominal-parameter backtest.

### Complete research workflow

When the user explicitly requests a complete quantitative research workflow, end-to-end strategy research, systematic validation, or a comprehensive research pipeline, prefer:

- `quant_research_pipeline`

The pipeline does not authorize skipping a dedicated check that the user separately requested. For example, a complete workflow plus a PIT check requires both `quant_research_pipeline` and `quant_data_pit`.

### Structured visualization

When the user requests a chart, structured quantitative visualization, equity-curve visualization, indicator visualization, performance visualization, or graphical research output, use:

- `quant_chart`

Do not substitute ASCII art or a plain-text table for an actual chart. Text may accompany the chart.

## Selection priority

1. Dedicated specialist tool for the requested operation.
2. `quant_research_pipeline` only when an end-to-end workflow is requested.
3. Generic Quant tool when no dedicated specialist tool applies.
4. `pwsh`, filesystem, or generic inspection for debugging, source inspection, environment diagnostics, auxiliary verification, or operations outside Quant-tool coverage.

Never use priority 4 to silently replace priority 1.

## Failure and fallback protocol

If a dedicated tool is unavailable, returns an explicit error, lacks required input, or cannot perform the requested operation:

1. Record `DEDICATED_TOOL = FAILED`.
2. Name the failed tool and include the error.
3. State the limitation that prevented the dedicated result.
4. If useful, perform a supplementary fallback method.
5. State the fallback limitation and its confidence impact.
6. Do not represent the fallback as equivalent to the dedicated result merely because it produces a number.

When the dedicated tool succeeds, record `DEDICATED_TOOL = SUCCESS` in the working evidence when a status record is useful.

## Manual scripts

Manual scripts are allowed for debugging, raw-data inspection, assumption validation, independent reproduction, auxiliary calculations, and environment diagnostics. They are not the default replacement for an applicable dedicated research-validation tool. Reproducing a calculation manually does not establish that the dedicated tool is unnecessary.

## Authority boundary and UNKNOWN

A tool result does not:

- redefine P0 or P1;
- certify an event;
- unlock a phase;
- override an UNKNOWN state;
- convert absence of evidence into evidence of absence.

If the applicable tool cannot establish the requested property, preserve `UNKNOWN` or `insufficient evidence` rather than inferring success. This discipline does not alter P0, P1-A, T1 sealed status, `UNKNOWN`, OI/FUNDING gates, FORWARD gates, `PHASE_2` gates, or V8 status.

## Pre-use check

Before choosing a generic tool for a quantitative research task, ask:

> Is there a dedicated TITAN Quant tool whose stated purpose directly matches this operation?

If yes, call that dedicated tool first. If no, use the most appropriate generic tool. If the dedicated tool fails, report the failure and distinguish any fallback from the dedicated result.
