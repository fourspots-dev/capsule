# DEC-001: Agent-initiated decision intake and ADR triage

- Status: promoted
- Captured: 2026-11-01
- Source: discussion
- Scope: agent-workflow, adr, requirements
- Triage: adr_and_requirement
- ADRs: ADR-013
- Requirements: REQ-ENG-006
- Supersedes: none
- Superseded by: none

## Statement

讨论中形成的长期决定需要由 Agent 主动捕获、留痕并在正确检查点发起 ADR
或需求确认，而不是等待用户记得要求写 ADR。

## Normalized decision

Use an append-only Decision Inbox for durable discussion decisions; Agent-owned
triage classifies each decision and proposes a new ADR when architecture
conditions apply. ADRs may exist without a REQ when they retain an originating
DEC.

## Rationale

The rule changes the cross-cutting governance contract and requires
implementation of registries, gates and tests. It cannot rely on conversation
memory or a particular REQ existing at the moment the decision is made.

## Promotion

- Decision record: `DEC-001`
- Architecture decision: `ADR-013`
- Implementation requirement: `REQ-ENG-006`
- User confirmation: the user approved consolidating the proposed mechanism into
  the repository workflow on 2026-11-01.
