# DEC-014: Layered host-neutral prompt composition

- Status: promoted
- Captured: 2026-11-02
- Source: discussion
- Scope: prompts, runtime, browser, tui, headless, subagents
- Triage: adr_and_requirement
- ADRs: ADR-020
- Requirements: REQ-PROMPT-001
- Supersedes: none
- Superseded by: none

## Statement

浏览器专用的完整 Prompt 不能直接复用于其他宿主；需要把通用策略、Workspace、宿主、模式、Profile 和动态能力拆层组合。

## Normalized decision

Replace monolithic host prompts with a structured prompt assembler. Core,
Workspace and mode policies remain host-neutral; Chrome, TUI, Headless and
future hosts provide isolated host policies; actual tools, Actions, code
intelligence, skills and runtime state are injected as typed contexts rather
than hard-coded prose.

## Rationale

The current Chrome prompt duplicates identity and mixes coding, browser and
patch instructions. Copying it to TUI or Headless would introduce nonexistent
capabilities, while trimming it independently would create divergent behavior.

## Promotion

- ADR-020 proposes the prompt composition architecture.
- REQ-PROMPT-001 links the detailed design and test design.
- Implementation remains blocked until the user approves ADR-020 and the
  requirement design.
