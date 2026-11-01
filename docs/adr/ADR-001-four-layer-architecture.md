# ADR-001: Four-layer host portable action toolpack architecture

- Status: accepted
- Date: 2026-11-01
- Approved by: user
- Requirements: REQ-HOST-002, REQ-ACTION-001, REQ-TEST-001, REQ-WORKSPACE-002
- Origin decision: none
- Supersedes: none
- Superseded by: none

## Context

The system must run across desktop, browser, iOS and remote sandboxes without
turning every host detail into a model-visible command. Treating every capability
as an Action would make storage, session persistence and boot circular.

## Decision

Use four layers:

1. Host Backend: Storage, FileSystem, Clock, Scheduler, Crypto, Network, Secret,
   Browser and Native Bridge.
2. Portable Runtime: VFS, Patch, Search, Diff, Portable Git, Session, Artifact
   and Capsule.
3. Application Actions: concrete Python, Xcode, Playwright, database and deploy
   operations.
4. ToolPack: the model-facing tools, Prompt, risk and approval composition.

## Invariants

- Host Backend is not implemented as Actions.
- Portable Runtime requires no host binary.
- Actions are leaf operations, not infrastructure.
- ToolPack is a composition layer, not a fourth backend.

## Alternatives considered

- Put every operation behind one generic bridge or exec.
- Put every capability in HostBridge.
- Let each client compose its own tools.

## Consequences

The architecture has explicit boundaries, but an additional composition layer
must select tools from capability reports.

## Affected surfaces

Core, Host, Runtime Composition, TUI, Headless, Chrome, iOS, Sandbox, Prompt and
Verification.

## Verification

Dependency checks, Host Baseline tests, ToolPack Golden and cross-profile
architecture tests.
