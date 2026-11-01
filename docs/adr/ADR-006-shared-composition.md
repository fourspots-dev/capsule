# ADR-006: Shared capability composition and client-state isolation

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-TUI-002, REQ-CHROME-001
- Supersedes: none
- Superseded by: none

## Context

TUI, Headless and Chrome previously composed tools independently. UI-specific
state such as tabs and panels could leak into Core, while tool schemas drifted.

## Decision

All clients consume a shared CapabilityGraph and ToolPackComposer. Host profiles
select capability sets. Client-specific state is optional and never authoritative
for Agent correctness.

## Invariants

- Core does not branch on TUI/Chrome.
- Same profile yields the same Tool Schema across clients.
- Prompt, ToolRegistry and UI use one CapabilityReport.
- Missing client state does not prevent Session resume.
- Browser Tab IDs remain in Browser/Chrome adapters.

## Alternatives considered

- Client-specific ToolPacks.
- Core-owned tab/terminal state.
- Static hard-coded Prompt per client.

## Consequences

Clients become composition roots and renderers, but cannot define separate Agent
business semantics.

## Affected surfaces

Runtime Composition, TUI, Headless, Chrome, Prompt, Session and client state.

## Verification

ToolPack Golden, Prompt/Registry parity, no client imports in Core and
cross-client E2E.
