# ADR-014: Explicit unreviewed design approval

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-ENG-007
- Origin decision: DEC-002
- Supersedes: none
- Superseded by: none

## Context

The normal implementation gate requires the user to review a detailed design.
There are cases where the user explicitly accepts the execution risk and wants
implementation to begin without claiming that the review happened.

## Decision

Add `designStatus: approved_unreviewed`. It allows implementation only when
`implementationAuthorized` is true and a non-empty `approvalNote` records that
the user approved without detailed review. It never masquerades as `approved`.

## Invariants

- `approved_unreviewed` preserves an explicit audit distinction from
  `approved`.
- A non-empty approval note is mandatory.
- Implementation authorization remains an independent explicit decision.
- Subsequent design changes do not inherit unreviewed approval silently.
- Reports and UI identify the state as unreviewed.

## Alternatives considered

- Treat unreviewed approval as ordinary `approved`.
- Block all implementation until detailed review.
- Use a free-form note without a distinct state.

## Consequences

The user can authorize urgent work without erasing review provenance. Risk is
visible in every registry and tool that reads design status.

## Affected surfaces

Requirement registry, requirement traceability policy, templates, engineering
guidance, release notes and future approval UI.

## Verification

Requirement policy tests accept authorized `approved_unreviewed` with a note,
reject it without a note, and continue rejecting ordinary `review` for
implementation. Registry inspection exposes the state without normalization.
