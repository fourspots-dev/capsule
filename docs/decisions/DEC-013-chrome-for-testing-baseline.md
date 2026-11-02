# DEC-013: Use Chrome for Testing as the E2E baseline

- Status: promoted
- Captured: 2026-11-02
- Source: request
- Scope: e2e, chrome, ci, release-verification
- Triage: adr_and_requirement
- ADRs: ADR-019
- Requirements: REQ-ENG-009
- Supersedes: none
- Superseded by: none

## Statement

Chrome 自动化测试改为以 Chrome for Testing 为主；Chrome Stable 只作为独立发布冒烟。

## Normalized decision

Use a pinned Chrome for Testing executable as the default E2E browser. Support
CfT headless for CI, CfT headed for local browser-UI observation and an explicit
Stable Chrome profile for release smoke. Do not silently replace CfT with Stable
Chrome in the default gate.

## Rationale

CfT is reproducible and allows unpacked MV3 extensions. Stable Chrome is valuable
for branded-release compatibility but is not the correct deterministic baseline.

## Promotion

- ADR-019 records the test baseline.
- REQ-ENG-009 implements the shared launcher, test profiles and documentation.
