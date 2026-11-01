# DEC-006: Authorize semantic code intelligence for 0.8.0

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: lsp, code-intelligence, tools
- Triage: requirement
- ADRs: none
- Requirements: REQ-LSP-001
- Supersedes: none
- Superseded by: none

## Statement

继续实现 LSP-backed code intelligence 与 portable text/symbol fallback。

## Normalized decision

Implement `REQ-LSP-001` through a language-neutral `CodeIntelligencePort`, an LSP
Action adapter and portable fallback tools shared by TUI and Headless.

## Rationale

The prior ADR triage classified LSP as a local feature inside the accepted
four-layer architecture. This decision authorizes its implementation.

## Promotion

- Decision record: `DEC-006`
- Implementation requirement: `REQ-LSP-001`
