# ADR-017: Use an outbound read-only execution debug hub

- Status: accepted
- Date: 2026-11-02
- Approved by: user
- Requirements: REQ-OBS-001
- Origin decision: DEC-011
- Supersedes: none
- Superseded by: none

## Context

Chrome MV3 cannot host an inbound HTTP server. Debug consumers nevertheless need
real-time access to Agent execution, including tool calls, reasoning output,
children, approvals and errors. Directly exposing extension storage or coupling
debug transport into Core would violate host boundaries and security.

## Decision

Runtime emits normalized execution events to an outbound `ExecutionEventSink`.
Chrome POSTs batches to a Debug Hub. A standalone Node Debug Hub owns ingestion,
bounded retention, cursor allocation, incremental HTTP queries, SSE and export.
The Hub is read-only and never exposes Agent control operations.

## Invariants

- Chrome never listens on a network port.
- Runtime state remains authoritative; Debug Hub is a derived observer.
- External consumers use opaque monotonic cursors and idempotent event IDs.
- Redaction occurs before events enter the Hub.
- Slow consumers never block Agent execution.
- Debug APIs cannot mutate, stop or approve Agent work.
- Hidden model chain-of-thought is never exported; only displayed reasoning or
  summaries are eligible.

## Alternatives considered

- Bind an HTTP server inside the extension. Rejected by the MV3 execution model.
- Read Chrome extension storage from external processes. Rejected because it
  bypasses product authorization and creates a brittle storage contract.
- Export only static Capsules. Rejected because it does not provide live pull.
- Give the Agent a debug-log tool. Rejected because it expands the execution
  surface and can create recursive observability behavior.

## Consequences

The product gains a separate debug process or optional remote relay. Event capture
must tolerate disconnects and bounded queues. Debug logs require stronger
redaction and retention policy than ordinary session persistence.

## Affected surfaces

- Runtime projection observer and normalized event schema
- Chrome event transport and Debug settings
- Standalone Node HTTP/SSE server
- External cursor query and export clients
- Engineering tests and release scripts
- No changes to Agent tools, Action schemas or Workspace Capsule format

## Verification

- Unit tests for event projection, redaction, cursor, retention and dedupe
- HTTP integration tests for authentication, ingest, query, SSE and export
- Chrome E2E proving outbound batching reaches an external Debug Hub
- Settings UI contract tests
