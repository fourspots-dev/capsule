# DEC-002: Explicit unreviewed approval and 0.6.0 first-wave authorization

- Status: promoted
- Captured: 2026-11-01
- Source: request
- Scope: approval, adr, requirements, release-plan
- Triage: adr_and_requirement
- ADRs: ADR-014
- Requirements: REQ-ENG-007
- Supersedes: none
- Superseded by: none

## Statement

增加“批准，但未仔细查阅”的状态，并据此批准版本重排和第一批开发。

## Normalized decision

Add `approved_unreviewed` design status with a mandatory approval note; authorize
`REQ-HOST-002` and `REQ-ACTION-001` for the first 0.6.0 implementation wave while
leaving later requirements frozen.

## Rationale

The approval state changes the cross-cutting governance contract and requires
implementation and tests. The user explicitly chose to authorize the first wave
without waiting for a detailed review and accepted responsibility for that
bounded approval.

## Promotion

- Decision record: `DEC-002`
- Architecture decision: `ADR-014`
- Implementation requirement: `REQ-ENG-007`
- Authorized first wave: `REQ-HOST-002`, `REQ-ACTION-001`
