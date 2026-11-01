# DEC-005: Authorize Capsule v2 for the 0.7.0 milestone

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: capsule, workspace-transfer, evidence, tui
- Triage: requirement
- ADRs: none
- Requirements: REQ-WORKSPACE-002
- Supersedes: none
- Superseded by: none

## Statement

继续实现流式 Capsule v2、TUI 导入预检和 Evidence/Action 重新绑定。

## Normalized decision

Implement `REQ-WORKSPACE-002` under the existing Capsule and portable-first ADRs
with compressed chunked v2 transport while preserving v1 imports.

## Rationale

ADR-002 and ADR-004 already govern portable transfer and Capsule as the
continuation unit. This decision authorizes the implementation slice.

## Promotion

- Decision record: `DEC-005`
- Implementation requirement: `REQ-WORKSPACE-002`
