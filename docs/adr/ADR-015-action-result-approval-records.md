# ADR-015: Action results and approvals are durable first-class records

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-ACTION-002
- Origin decision: DEC-003
- Supersedes: none
- Superseded by: none

## Context

Dropping Action metadata before Session/UI storage hides exit status, duration,
truncation, artifact references and approval scope. Production audits cannot
reconstruct what was approved or which Action produced a result.

## Decision

Carry Action result metadata through ToolExecutionResult and ConversationRow.
Persist approval receipts for every required approval. Inline binary artifacts
are stored in the ArtifactStore rather than coerced to lossy text.

## Invariants

- Artifact references and truncation never disappear between Provider and UI.
- An approval receipt binds session, task, tool, input digest, Action version,
  Workspace identity/generation and environment fingerprint.
- Denied and timed-out approvals are recorded as terminal receipts.
- Binary output is preserved as an artifact.
- Providers requiring idempotency never receive a duplicate side effect for the
  same execution scope.
- An aborted or late remote response cannot become success for a newer request.

## Alternatives considered

- Keep metadata only in the model-facing JSON value.
- Store approvals only in conversation messages.
- Convert binary output to UTF-8.
- Let providers manage duplicate suppression independently.

## Consequences

Core types and persistence gain optional metadata, while all surfaces share one
auditable truth. Approval storage can reveal execution context but must not
contain secrets beyond the approved input.

## Affected surfaces

Tool contracts, ToolExecutor, Action tools/providers, ArtifactStore, Session
rows/projection, TUI Action manager, Headless and Capsule persistence.

## Verification

Tool metadata round-trip tests, artifact binary tests, approval receipt tests,
idempotency tests, late-response tests and TUI Action manager rendering tests.
