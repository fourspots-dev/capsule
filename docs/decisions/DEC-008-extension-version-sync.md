# DEC-008: Synchronize extension manifest with the product version

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: extension, release, versioning, build
- Triage: requirement
- ADRs: none
- Requirements: REQ-ENG-008
- Supersedes: none
- Superseded by: none

## Statement

Chrome 扩展重载后应显示与 `package.json` 一致的产品版本，不能继续显示
`0.1.0`。

## Normalized decision

Generate the extension manifest version from `package.json` during builds and
fail CI when the checked-in manifest drifts.

## Rationale

This enforces the existing single-product-version rule at the browser packaging
boundary and prevents ambiguity when manually reloading an unpacked extension.

## Promotion

- Decision record: `DEC-008`
- Implementation requirement: `REQ-ENG-008`
