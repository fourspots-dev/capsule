# ADR-005: Completion requires current environment-bound evidence

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-TEST-001, REQ-ACTION-001
- Supersedes: none
- Superseded by: none

## Context

Exit code alone cannot prove tests ran or passed. Historical tests from another
host or before a file change can create false completion.

## Decision

Use structured TestReport and Evidence records bound to Workspace generation,
file hashes, Action/version and environment fingerprint. Verifier accepts only
current evidence after the latest write.

## Invariants

- Zero tests do not prove completion.
- Stale evidence is historical, not current verification.
- Missing failure Artifacts make the report invalid.
- TUI and Headless use the same evidence lifecycle.

## Alternatives considered

- Trust exit code.
- Trust model narrative.
- Treat all stored test reports as current.

## Consequences

Action Providers must return structured reports or normalized runner output.

## Affected surfaces

Action Runtime, TestDiscovery, Verifier, Artifact Store, TUI review, Session and
Capsule.

## Verification

TestReport schema, evidence state transitions, file/environment/version drift,
verifier gates and migration tests.
