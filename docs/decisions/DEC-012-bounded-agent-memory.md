# DEC-012: Bound streaming and resident Agent memory

- Status: promoted
- Captured: 2026-11-02
- Source: incident
- Scope: runtime, projection, chrome-ui, persistence, debug, browser
- Triage: adr_and_requirement
- ADRs: ADR-018
- Requirements: REQ-PERF-001
- Supersedes: none
- Superseded by: none

## Statement

一个浏览器任务已消耗约 11 GB 内存，必须彻底修复 token 级全量快照、全量重渲染和无界缓存，而不是只调整 GC。

## Normalized decision

Replace hot-path full Projection snapshots with source-level deltas, coalesce and
window UI rendering, bound persistence and retained logs, cap non-resident
sessions and host capture caches, and enforce byte/row limits in debug transport.

## Rationale

The observed memory is orders of magnitude above the model transcript size and
cannot be explained by page snapshots alone. Multiple O(history) copies per token
and full DOM reconstruction amplify a long task into multi-gigabyte churn.

## Promotion

- ADR-018 defines bounded streaming and resident-state invariants.
- REQ-PERF-001 implements and measures the hot-path remediation.
