# ADR-003: Application Actions are trusted leaf capabilities

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-HOST-001, REQ-ACTION-001, REQ-CHROME-001
- Origin decision: none
- Supersedes: none
- Superseded by: none

## Context

Real compilation, testing, native tooling and remote execution are
application-specific. Exposing a generic shell gives all code unrestricted host
access and makes capabilities impossible to describe or approve.

## Decision

Applications register named Actions with versioned JSON Schemas, effects, risk,
Probe and Workspace binding. Provider modules are trusted host inputs. Project
files cannot auto-load Provider code by default.

## Invariants

- The model sees named Actions, never raw command paths.
- Unavailable or denied Actions do not fall back to exec.
- Approval is scoped to Action, input digest, Session and generation.
- Providers must support cancellation and structured results.

## Alternatives considered

- Universal exec.
- Auto-load Action modules from the project directory.
- One global MCP endpoint with unrestricted tool injection.

## Consequences

Every application must integrate a Provider for its real toolchain, but gains
explicit capability discovery and policy.

## Affected surfaces

Platform Action contracts, Runtime Invoker, Node Local Adapter, TUI, Headless,
Chrome, iOS, Remote Runner and Prompt.

## Verification

Provider contract, trust loader, approval, process-tree cancellation, remote
parity and no-exec fallback tests.
