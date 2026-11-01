# DEC-004: Authorize TestEvidence for the 0.7.0 milestone

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: test-evidence, completion, workspace
- Triage: requirement
- ADRs: none
- Requirements: REQ-TEST-001
- Supersedes: none
- Superseded by: none

## Statement

继续按推荐顺序实现 TestEvidence，确保测试报告、文件 hash、环境和 Action
版本约束任务完成。

## Normalized decision

Implement `REQ-TEST-001` under the existing evidence-bound completion ADR before
moving to Capsule v2.

## Rationale

The governing architecture rule already exists in ADR-005. This decision
authorizes its implementation and keeps Capsule work behind a trustworthy
completion signal.

## Promotion

- Decision record: `DEC-004`
- Implementation requirement: `REQ-TEST-001`
