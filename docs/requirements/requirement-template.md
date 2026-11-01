# REQ-<AREA>-<NNN> <Title>

- Type: feature | bugfix | security | refactor | infrastructure | documentation
- Priority: P0 | P1 | P2 | P3
- Status: proposed
- Design status: draft | review | approved
- Implementation authorized: false
- Target version: A.B.C
- Architecture impact: yes | no
- Architecture decisions: ADR-NNN, ADR-NNN | none
- ADR review: pending | existing | proposed | not_required
- ADR review rationale:
- ADR reviewed at: YYYY-MM-DD
- Design: docs/<path>#<anchor>
- Test design: docs/<path>#<anchor>
- Legacy aliases:

## Problem

Describe the user or engineering problem. Include evidence and affected clients.

## Goal

Describe the observable outcome.

## Non-goals

List explicitly excluded behavior.

## Architecture impact map

| Surface | Action | Evidence / reason |
|---|---|---|
| Core / Host / Adapter | modify / none | |
| Headless / TUI / CLI / Chrome / Sandbox | modify / none | |
| Prompt / ToolRegistry / UI | modify / none | |
| Session / Artifact / Capsule | modify / none | |
| Lifecycle / cancellation / recovery | modify / none | |
| Legacy cleanup / fallback | modify / none | |

Mark every required consumer as `modify` with an evidence target, or `none`
with a technical reason. List forbidden partial-delivery shortcuts.

## Acceptance

1. Observable result.
2. Failure behavior.
3. Compatibility requirement.
4. Every required consumer is reachable through the shared architecture.
5. Verification evidence, including at least one end-to-end journey when the
   requirement spans clients or hosts.

## Risks

List migration, security, performance and rollout risks.

## Change history

- YYYY-MM-DD: Proposed.
