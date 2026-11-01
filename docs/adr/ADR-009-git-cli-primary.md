# ADR-009: Git CLI as the primary backend

- Status: superseded
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-GIT-001
- Origin decision: none
- Supersedes: none
- Superseded by: ADR-002

## Context

An early implementation plan preferred the host Git executable and treated
Portable Git as a fallback.

## Decision

Use Git CLI as the primary coding backend.

## Invariants

This decision is historical and must not be used for new implementation.

## Alternatives considered

Portable Git compatibility layer.

## Consequences

The approach cannot support browser/iOS consistently.

## Affected surfaces

Git ToolPack and host adapters.

## Verification

Superseded by ADR-002.
