# DEC-010: Enforce Side Panel UI consistency without AGENTS constraints

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: sidepanel, ui-contract, settings-components, testing
- Triage: adr_and_requirement
- ADRs: ADR-016
- Requirements: REQ-UI-001
- Supersedes: none
- Superseded by: none

## Statement

不要把 UI 一致性规则直接写进 `AGENTS.md`；采用 UI Contract、可复用设置组件、自动化检查和需求模板来约束后续实现。

## Normalized decision

Keep `AGENTS.md` free of project-specific UI rules. Make the Side Panel settings
contract discoverable through linked engineering documents, make the canonical
settings implementation available as reusable components, and enforce deviations
through executable checks plus end-to-end tests. Requirement and architecture
templates must request UI impact and evidence.

## Rationale

Chat context is temporary, while an oversized AGENTS file is easy to ignore and
hard to maintain. Component APIs and failing checks make correct composition the
default without duplicating visual rules across every agent instruction file.

## Promotion

- ADR-016 records the durable enforcement model.
- REQ-UI-001 implements the UI Contract, settings primitives, checks, templates
  and E2E evidence.
