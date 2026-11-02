# DEC-011: Add a read-only execution debug hub

- Status: promoted
- Captured: 2026-11-02
- Source: request
- Scope: observability, chrome, debug-server, execution-events
- Triage: adr_and_requirement
- ADRs: ADR-017
- Requirements: REQ-OBS-001
- Supersedes: none
- Superseded by: none

## Statement

Chrome 插件不监听端口；插件把执行事件发送给 tinyai Debug Hub，外部服务通过 cursor 和 SSE 实时拉取。

## Normalized decision

Add a read-only execution event pipeline. Hosts emit normalized, redacted events
to an outbound transport. A local or remote Debug Hub assigns monotonic cursors,
stores bounded NDJSON, exposes incremental query and SSE endpoints, and supports
bundle export. The Hub cannot control or mutate the Agent.

## Rationale

MV3 extensions cannot accept inbound TCP connections. Outbound ingestion preserves
the browser sandbox while enabling local and remote observability. A dedicated
Hub keeps debug traffic out of the Agent state machine and gives external tools a
stable cursor protocol.

## Promotion

- ADR-017 records the architecture and security boundary.
- REQ-OBS-001 implements events, transport, Hub, server, UI and tests.
