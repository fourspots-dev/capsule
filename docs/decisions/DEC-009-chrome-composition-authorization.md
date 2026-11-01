# DEC-009: Authorize Chrome shared composition for 0.10.0

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: chrome, capability-composition, remote-action, capsule
- Triage: requirement
- ADRs: none
- Requirements: REQ-CHROME-001
- Supersedes: none
- Superseded by: none

## Statement

继续实现 Chrome 共享 Capability Composition、Remote Action 和 Capsule UI。

## Normalized decision

Implement `REQ-CHROME-001` using the shared workspace capability composition,
separate browser ToolPack, Remote Action provider, current TestEvidence and
Capsule transfer UI.

## Rationale

The shared composition and client isolation rules are already accepted in
ADR-006. This decision authorizes the Chrome implementation slice.

## Promotion

- Decision record: `DEC-009`
- Implementation requirement: `REQ-CHROME-001`
