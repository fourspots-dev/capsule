# ADR-013: Agent-initiated decision intake and ADR triage

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-ENG-006
- Origin decision: DEC-001
- Supersedes: none
- Superseded by: none

## Context

Important architecture decisions can emerge during open discussion before a REQ
exists. Relying on the user to explicitly request an ADR loses those decisions,
while treating every comment as an ADR creates noise and bypasses review.

## Decision

Capture durable discussion decisions as immutable `DEC-NNN` records. The Agent
performs ADR triage at REQ creation, before detailed design approval, when an
implementation discovers a new boundary, and before release. If a decision meets
the ADR conditions, the Agent creates a Proposed ADR, links its origin DEC, and
pauses dependent work for user review.

## Invariants

- A DEC does not grant implementation permission.
- An ADR has at least one provenance source: a REQ or an originating DEC.
- An ADR may exist without a current REQ when its Origin decision is recorded.
- Proposed ADRs and pending requirement triage block design approval and
  implementation.
- Agents capture decisions proactively; users are not required to request ADRs.
- DEC, ADR and REQ identifiers are immutable and never reused.

## Alternatives considered

- Require every discussion decision to belong to a REQ immediately.
- Store decisions only in chat history.
- Promote every detected decision directly to an Accepted ADR.
- Wait for periodic manual architecture review.

## Consequences

The repository gains a small intake registry and three-way traceability. Agents
must perform semantic triage and stop for review when a durable decision needs
user judgment, but routine local changes incur no extra ADR.

## Affected surfaces

AGENTS.md, Decision Registry, ADR Registry, Requirement Registry, verification
scripts, process documentation and future decision-confirmation clients.

## Verification

Run `npm run decisions:check`, `npm run adr:check`,
`npm run requirements:check` and the decision-policy tests. The tests reject
missing triage, broken DEC/ADR/REQ backlinks, ADRs without provenance and
Proposed decisions that enter implementation.
