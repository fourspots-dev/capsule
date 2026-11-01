# DEC-007: Authorize fork-bound subagent isolation for 0.9.0

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: subagent, action-isolation, workspace, evidence
- Triage: requirement
- ADRs: none
- Requirements: REQ-SUBAGENT-001
- Supersedes: none
- Superseded by: none

## Statement

继续实现通用 profile 子 Agent 的 fork-bound Action、Workspace generation、
Evidence 与取消隔离。

## Normalized decision

Implement `REQ-SUBAGENT-001` under ADR-007 by binding each child invocation to
its own Session, Workspace fork generation, Evidence scope and parent
cancellation tree.

## Rationale

Generic subagent profiles are already the accepted architecture; this decision
authorizes fork-bound execution implementation.

## Promotion

- Decision record: `DEC-007`
- Implementation requirement: `REQ-SUBAGENT-001`
