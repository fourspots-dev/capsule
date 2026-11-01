# ADR-010: Represent every capability as an Action

- Status: rejected
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-HOST-002, REQ-ACTION-001
- Origin decision: none
- Supersedes: none
- Superseded by: none

## Context

Action-based execution could be extended to all host capabilities.

## Decision

Use Actions for Storage, FileSystem, Session, Clock and other infrastructure.

## Invariants

Rejected. Host baseline ports remain mandatory.

## Alternatives considered

Four-layer architecture with Host Ports, Portable Runtime, Actions and ToolPack.

## Consequences

Moving all capabilities to Actions creates boot cycles and obscures security
boundaries.

## Affected surfaces

Host, Runtime and Action architecture.

## Verification

ADR-001 and Host Baseline tests enforce the accepted alternative.
