# ADR-004: Workspace Capsule is the sole cross-host transfer unit

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-WORKSPACE-001, REQ-WORKSPACE-002
- Origin decision: none
- Supersedes: none
- Superseded by: none

## Context

Files, Sessions, Git state, Artifacts and test evidence are stored separately.
Exporting only a project archive loses the Agent's work and produces dangling
references after migration.

## Decision

Export and import one versioned, integrity-checked Workspace Capsule containing
Project, AgentState, Repository, Artifacts, Evidence, Environment and optional
ClientState.

## Invariants

- Workspace ID remains stable across hosts.
- Import is staged and atomically activated.
- Running process, PTY, network connection and Secret state are not migrated.
- Missing required Actions block or degrade explicitly.
- Environment changes stale old execution evidence.

## Alternatives considered

- Transfer only project files.
- Copy host storage-key directories.
- Replace Session IDs during import.

## Consequences

Capsule creation requires a quiesce/flush barrier, integrity checks and schema
migration, but produces a complete continuation unit.

## Affected surfaces

Workspace, Session, Portable Git, Artifact, Evidence, TUI, Chrome and host
transport.

## Verification

Capsule integrity, atomic import, Session resume, Git/history round trip, large
workspace streaming and Node-to-Chrome-to-Node E2E.
