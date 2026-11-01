# ADR-012: Generic exec as a baseline capability

- Status: rejected
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-HOST-001, REQ-ACTION-001
- Supersedes: none
- Superseded by: none

## Context

A single general exec capability could reduce host adapter work.

## Decision

Expose a built-in generic shell/binary runner to the model.

## Invariants

Rejected. Concrete execution uses named Application Actions. A local argv helper
may exist internally behind an explicitly registered action.

## Alternatives considered

Trusted Provider Modules and Host Action Registry.

## Consequences

Generic exec makes capability discovery, approval, cross-platform behavior and
security impossible to bound precisely.

## Affected surfaces

Host, Action Runtime, Prompt, TUI, Chrome and iOS.

## Verification

ADR-003 and Action Runtime no-fallback tests enforce the accepted alternative.
