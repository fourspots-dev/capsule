# ADR-008: Detailed design approval and explicit implementation authorization

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-ENG-004, REQ-ENG-005
- Supersedes: ADR-011
- Superseded by: none

## Context

An accepted requirement or architecture summary was previously treated as enough
to begin code. This allowed partial architecture implementation and ambiguous
authorization.

## Decision

Every requirement records `designStatus` and `implementationAuthorized`.
Detailed design and test design must be reviewed by the user before code changes.
Agents cannot self-approve or self-authorize.

## Invariants

- `accepted` means requirement accepted, not implementation permission.
- In-progress requires approved design and explicit authorization.
- Detailed design includes modules, interfaces, states, errors, migration and
  tests.
- Duplicate or superseded decisions are managed through ADRs.

## Alternatives considered

- Conversation-only authorization.
- Automatic implementation after document acceptance.
- No formal ADR layer.

## Consequences

Development starts later, but scope and architectural boundaries are auditable.

## Affected surfaces

AGENTS.md, requirement registry, design/test templates, commit hooks, CI and all
future requirements.

## Verification

Requirement policy tests reject in-progress requirements without approval and
authorization; ADR registry checks reject invalid supersedes and missing
approvals.
