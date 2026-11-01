# ADR-002: Portable runtime and portable Git first

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-WORKSPACE-001, REQ-WORKSPACE-002, REQ-GIT-001, REQ-PLATFORM-001
- Origin decision: none
- Supersedes: ADR-009
- Superseded by: none

## Context

Browser and iOS sandboxes do not reliably provide Git, package managers or
native processes. The common local Git subset should still work everywhere.

## Decision

Implement Workspace semantics and common local Git semantics in portable
TypeScript. Use `PortableGitBackend` by default and expose `CliGitBackend` only
as an optional interoperability/advanced backend.

## Invariants

- Missing Git binary is not a degraded state.
- Git tools share one schema on all hosts.
- Portable development of common local Git operations requires no Node imports.
- Real Git remains the format/conformance oracle in tests.

## Alternatives considered

- Require host Git everywhere.
- Ship a native Git binary in every application.
- Replace Git with an unrelated snapshot-only model.

## Consequences

Portable format compatibility and pack/index parsing become product
responsibilities, while host variance is reduced.

## Affected surfaces

Git ToolPack, Workspace Capsule, browser/iOS profiles, Node/Sandbox adapters and
Git conformance tests.

## Verification

Portable Git contract tests, real Git interop, browser pure-JS tests and Capsule
repository round trips.
