# ADR-020: Compose layered host-neutral Agent prompts

- Status: proposed
- Date: 2026-11-02
- Approved by: none
- Requirements: REQ-PROMPT-001
- Origin decision: DEC-014
- Supersedes: none
- Superseded by: none

## Context

Prompt construction is currently split between a Workspace capability prompt,
a Chrome-specific prompt and dynamic skill/profile text. These blocks duplicate
identity, mix host-specific assumptions and hard-code descriptions of tools that
may not exist. Other hosts require different tab, process, terminal and approval
semantics.

## Decision

Build prompts through one deterministic assembler with typed sections:

1. Core Policy
2. Workspace Policy
3. Host Policy
4. Execution Policy
5. Mode Policy
6. Agent Profile
7. Capability and Skill Context
8. Runtime Context

Core, Workspace and Mode policies are shared across hosts. Host-specific facts
must not appear in Core. Dynamic capabilities derive from the active Tool,
Action, Code Intelligence and Skill registries.

## Invariants

- Core Policy never mentions Chrome, tabs, PTY, shell or a concrete tool.
- A host cannot expose another host's policy or unavailable capability.
- Runtime facts are data, not instructions that override Core.
- Profile and Skill instructions may restrict behavior but cannot expand
  permissions or bypass approval.
- Tool schemas remain the source of tool argument protocol.
- Stable sections precede volatile sections for prompt caching.
- Every section has trust, priority and token-budget metadata.

## Alternatives considered

- Maintain one full prompt per host. Rejected because behavior will diverge and
  fixes must be copied repeatedly.
- Keep one universal prompt containing every host. Rejected because unavailable
  browser/terminal concepts cause hallucinated tool use.
- Generate prose ad hoc from tool names. Rejected because ordering, trust and
  conflict resolution would be unstable.

## Consequences

Prompt construction gains a component model and test surface. Existing direct
string builders need migration. Dynamic contexts must be sanitized and bounded.
Prompt caching becomes more effective because policy prefixes are stable.

## Affected surfaces

- Runtime prompt composition
- Chrome, TUI, Headless and future host adapters
- Tool, Action, Code Intelligence and Skill registries
- Agent profiles and plan/read-only/build modes
- Prompt golden and behavioral tests

## Verification

- Assembler unit tests
- Per-host prompt golden tests
- Capability-derived dynamic context tests
- Browser and TUI behavior E2E
- Trust, conflict, budget and cache-prefix tests
