# DEC-003: Harden Action results approvals and observability

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: action, approval, artifact, tui, observability
- Triage: adr_and_requirement
- ADRs: ADR-015
- Requirements: REQ-ACTION-002
- Supersedes: none
- Superseded by: none

## Statement

先继续 0.6 硬化：补 ActionResult 元数据、Action Manager、审批票据、二进制输出、幂等和迟到结果测试。

## Normalized decision

Treat Action result metadata and approval receipts as durable first-class data;
expose an Action manager; preserve binary artifacts; prevent duplicate side
effects for providers that require idempotency; and never accept late remote
results as success.

## Rationale

The 0.6.0 runtime executes Actions but drops useful result metadata before it
reaches Session and UI, and approvals remain invocation-local. Those gaps weaken
observability and auditability for production use.

## Promotion

- Decision record: `DEC-003`
- Architecture decision: `ADR-015`
- Implementation requirement: `REQ-ACTION-002`
