# ADR-011: Accepted requirements automatically authorize implementation

- Status: superseded
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-ENG-004
- Origin decision: none
- Supersedes: none
- Superseded by: ADR-008

## Context

The old workflow did not distinguish requirement acceptance from authorization to
write product code.

## Decision

Treat `accepted` status as implementation permission.

## Invariants

This decision is historical and must not be used for new implementation.

## Alternatives considered

Separate detailed design review and implementation authorization.

## Consequences

Ambiguous scope and premature implementation.

## Affected surfaces

Requirement workflow.

## Verification

Superseded by ADR-008.
