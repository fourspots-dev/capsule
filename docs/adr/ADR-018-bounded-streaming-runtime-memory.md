# ADR-018: Stream deltas and bound resident runtime memory

- Status: accepted
- Date: 2026-11-02
- Approved by: user
- Requirements: REQ-PERF-001
- Origin decision: DEC-012
- Supersedes: none
- Superseded by: none

## Context

Live Agent execution generated a full ProductProjection clone for every model
delta, followed by full DOM reconstruction. Persistence periodically cloned the
entire SessionSnapshot, debug events repeated accumulated text, and several
host caches had no retention boundary. A single browser task reached roughly
11 GB memory.

## Decision

Hot-path consumers subscribe to source-generated Projection deltas. Full
Projection snapshots are limited to initial subscription and explicit reads.
Side Panel rendering coalesces streaming updates and renders a bounded recent-row
window. Persistence, Event Log, browser network capture, debug transport and
resident Session caches all have explicit bounds.

## Invariants

- A streaming text delta never clones the full Projection or session history.
- RuntimeGateway and Debug use `subscribeChanges`, not recurring full snapshots.
- Debug `row.delta` events contain only appended text and length metadata.
- Side Panel renders at most 500 recent rows and 100,000 characters per message.
- Event Log retains at most 20,000 in-memory events while sequence remains monotonic.
- Persistence is throttled to at least 500ms during streaming.
- At most 6 idle persisted Sessions remain resident by default.
- Debug queue is bounded by item count and 2MB estimated bytes.
- Browser network capture retains at most 300 requests per tab.

## Alternatives considered

- Increase garbage collection or ask users to reload. Rejected as mitigation,
  not a fix.
- Disable reasoning/tool history. Rejected because it removes essential product
  behavior.
- Persist every token more often. Rejected because it adds full-snapshot traffic.
- Virtualize every DOM row immediately. Deferred; bounded window and update
  coalescing provide the first safe invariant without changing turn rendering.

## Consequences

UI may show a bounded recent window rather than thousands of DOM rows; full
history remains in Session/Capsule/export. Incremental tracking adds internal
dirty-row bookkeeping and must be tested against full Projection equality.

## Affected surfaces

- SessionRuntime projection notifications and EventLog
- RuntimeGateway subscription protocol
- Side Panel streaming renderer
- Session persistence and resident cache
- Chrome network capture
- Debug projection tracking and transport
- Tests and load diagnostics

## Verification

- Full-vs-delta equality integration test
- Retention and render-window unit tests
- Debug queue byte-bound test
- Real Chrome E2E and long-stream heap/RSS comparison
