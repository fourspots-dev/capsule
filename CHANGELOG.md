# Changelog

## 0.10.0

### Features

- `REQ-CHROME-001`: compose Chrome through the shared portable Workspace
  capability graph while keeping Browser DOM tools in a separate ToolPack.
- Add optional allowlisted Remote Action discovery and invocation with request
  binding, cancellation, timeout handling and no generic shell fallback.
- Add a compact Side Panel Action/Evidence capability board and Remote Action
  configuration.
- Add Workspace Capsule v2 export and atomic import through the Runtime
  Gateway, restoring sessions and evidence without exposing storage to the UI.
- Allow read-only tasks to complete without TestEvidence while retaining the
  verification gate after write, delete or Git mutation tools.

### Verification

- `npm run check`: 432 tests passed, 3 skipped.
- `npm run test:e2e`: 6 Chrome extension tests passed, including real Remote
  Action invocation and Capsule download/import.
- TUI/Headless/Chrome Portable Tool Golden parity, no `exec`/job tools, browser
  ToolPack separation and disconnect/late-result failure paths.
- `npm run verify:tui`.

## 0.9.1

### Fixes

- `REQ-ENG-008`: synchronize Chrome's extension manifest version from the
  single `package.json` product version during builds.
- Add `npm run extension:check` to reject unpacked or packaged manifest version
  drift before tests and build.

### Verification

- `tests/unit/extension-version.test.ts`
- `npm run extension:check`
- `npm run check`: 425 tests passed, 3 skipped.
- Chrome extension E2E and packaged ZIP manifest inspection

## 0.9.0

### Features

- `REQ-SUBAGENT-001`: bind each child Action invocation to its own Session,
  Workspace fork, generation, VFS and Evidence scope.
- Reject root-only Actions in child workspaces; allow only descriptors that
  explicitly declare a fork binding.
- Invalidate approval when Workspace generation or environment changes before
  Action execution.
- Propagate child Artifact and Evidence IDs into structured ChildResult output.
- Preserve recursive parent cancellation and generic configurable agent
  profiles.

### Verification

- `npm run check`: 423 tests passed, 3 skipped.
- `npm run test:e2e`: 5 Chrome extension tests passed.
- `npm run verify:tui`: real PTY coding loop and current TestEvidence passed.

## 0.8.0

### Features

- `REQ-LSP-001`: add a language-neutral CodeIntelligencePort shared by TUI and
  Headless.
- Add portable text/symbol discovery, lexical definitions/references,
  cancellation, source-size limits and explicit fallback limitations.
- Add an LSP Action adapter for diagnostics, symbols, definitions, references
  and WorkspaceEdit code-action proposals.
- Expose `code_capabilities`, `code_diagnostics`, `code_symbols`,
  `code_definition`, `code_references` and `code_actions` tools with matching
  Prompt capability reporting.

### Verification

- `npm run check`: 419 tests passed, 3 skipped.
- `npm run test:e2e`: 5 Chrome extension tests passed.
- `npm run verify:tui`: real PTY coding loop and current TestEvidence passed.

## 0.7.0

### Features

- `REQ-TEST-001`: add portable test discovery, JSON/JUnit TestReport parsing,
  durable TestEvidence and completion guards bound to current file hashes,
  Workspace generation, environment fingerprint and Action version.
- Reject zero tests, malformed reports, stale evidence, changed files and
  failed reports without failure Artifacts.
- `REQ-WORKSPACE-002`: add compressed, chunked, content-addressed Capsule v2
  with backward-compatible v1 import.
- Add explicit TUI `--import-capsule` preflight with replace/merge modes,
  sessions/artifacts/evidence counts, missing Actions and path changes.
- Persist TestEvidence in Capsule, invalidate it across environment changes, and recover interrupted imports through a durable HostStorage journal.

### Verification

- `npm run check`: 416 tests passed, 3 skipped.
- `npm run test:e2e`: 5 Chrome extension tests passed.
- `npm run verify:tui`: real PTY Action + current TestEvidence + Capsule v2 export.
- Manual Capsule v2 export/import with byte-equal project restoration.

## 0.6.1

### Fixes

- `REQ-ACTION-002`: carry Action result metadata through ToolExecutionResult,
  Session rows and TUI rendering without changing legacy tool outputs.
- Preserve binary and failure artifacts through ArtifactStore, including bounded
  raw stdout/stderr bytes in the local executor.
- Persist approved, denied and cancelled approval receipts through HostStorage,
  and fail closed when receipt storage is unavailable.
- Add required-idempotency scopes, dynamic Workspace generation binding and
  late-remote-response rejection.
- Add a read-only TUI Action Manager on `Ctrl+Y` for state, version, effects,
  risk, source and limitations.

### Verification

- `npm run check`: 403 tests passed, 3 skipped.
- `npm run test:e2e`: 5 Chrome extension tests passed.
- `npm run verify:tui`: real PTY Action metadata and Capsule export passed.

## 0.6.0

### Features

- `REQ-HOST-002`: add the shared Host Baseline Matrix for TUI, Chrome, iOS,
  sandbox and memory profiles; startup fails only when Core or Workspace
  baselines are missing and explicitly degrades Real Execution when no Action is
  available.
- `REQ-ACTION-001`: add trusted absolute Action module loading with hash checks,
  a shell-free local argv executor, Remote Action protocol, provider
  cancellation/disposal, registry input validation and lifecycle re-probing.
- Add blocking TUI ask/allow/deny approval for dangerous Actions and bind
  approvals to Action/input/workspace/environment context.
- Integrate Host Baseline state into shared CapabilityGraph, Prompt and startup
  fingerprints across TUI and Headless; Chrome startup now applies the same
  baseline without making Actions mandatory.

### Verification

- `npm run check`: 391 deterministic tests passed, 3 skipped.
- `npm run test:e2e`: 5 Chrome extension tests passed.
- `npm run verify:tui`: real pseudo-terminal Action execution and Capsule export.

## 0.5.1

### Infrastructure

- `REQ-ENG-007`: add `approved_unreviewed` design status. It permits explicit
  implementation authorization without representing the design as reviewed and
  requires an audit note.
- Approve and move `REQ-HOST-002` and `REQ-ACTION-001` into the first `0.6.0`
  implementation wave; subsequent capability requirements retain review-only
  status.

### Verification

- `tests/unit/requirement-policy.test.ts`
- `npm run requirements:check`

## 0.5.0

### Infrastructure

- `REQ-ENG-006`: add an agent-owned Decision Inbox for durable decisions made
  during discussion, independent of an existing requirement.
- Add mandatory `adrReview` triage for new requirements from 0.5.0, including
  traceable `existing`, `proposed`, and `not_required` outcomes.
- Allow ADRs without a current REQ when they retain an `Origin decision` and
  require the Agent to create a Proposed ADR before requesting user review.
- Add DEC/ADR/REQ three-way validation, documented interaction checkpoints and
  the first promoted decision chain `DEC-001 → ADR-013 → REQ-ENG-006`.

### Verification

- `npm run decisions:check`
- `npm run adr:check`
- `npm run requirements:check`
- `npm run check`

## 0.4.3

### Infrastructure

- `REQ-ENG-005`: establish Architecture Decision Record governance with
  immutable IDs, user-approved lifecycle states, bilateral supersede links,
  requirement traceability, registered-document validation and CI enforcement.
- Seed the registry with 12 accepted, rejected or superseded decisions covering
  the four-layer architecture, portable runtime and Git, trusted leaf Actions,
  Workspace Capsules, evidence-bound completion, shared capability composition,
  generic subagent profiles and the design-to-implementation gate.

### Verification

- `npm run adr:check`
- `npm run requirements:check`
- `npm test -- tests/unit/adr-policy.test.ts tests/unit/requirement-policy.test.ts`

## 0.4.2

### Infrastructure

- `REQ-ENG-004`: require detailed design and detailed test design, explicit user
  design approval and implementation authorization before any requirement can
  enter implementation.
- `REQ-HOST-002`, `REQ-ACTION-001`, `REQ-TEST-001`, `REQ-WORKSPACE-002`,
  `REQ-LSP-001`, `REQ-SUBAGENT-001`, `REQ-CHROME-001`,
  `REQ-PLATFORM-001`, `REQ-EVAL-001`: add implementation-level design and test
  mappings; all remain in review without implementation authorization.

## Unreleased

### Planned

- `REQ-ACTION-001`: trusted Application Action runtime with provider SDK,
  local/native/remote execution, interactive approval and TestEvidence.
- `REQ-HOST-002`: normative Host Baseline Matrix and startup capability probes.
- `REQ-TEST-001`: portable TestDiscovery, TestReport and current-evidence gate.
- `REQ-WORKSPACE-002`: TUI Capsule import and streaming crash-safe Capsule v2.
- `REQ-LSP-001`: LSP-backed semantic code intelligence and portable fallback.
- `REQ-SUBAGENT-001`: fork-bound Action isolation and merge evidence.
- `REQ-CHROME-001`: shared Chrome capability composition and remote Actions.
- `REQ-PLATFORM-001`: Windows, Linux and iOS baseline adapters.
- `REQ-EVAL-001`: production coding benchmarks, fault injection and soak.

## 0.4.1

### Features

- `REQ-TUI-003`: export a flushed Workspace Capsule from TUI with `Ctrl+X` or
  `--capsule-export`, including Project, Portable Git, Session, Artifact,
  evidence and environment state.

### Verification

- `npm run check`
- `npm run verify:tui`
- `npm run test:e2e`

## 0.4.0

### Features

- `REQ-TUI-002`: migrate TUI onto the shared host capability composition,
  application Action registry, dynamic capability prompt and profile-aware
  completion guard; Portable is the default shell-free profile and VirtualShell
  remains available only through explicit Legacy mode.

### Verification

- `npm run check`
- `npm run test:e2e`
- `npm run verify:tui`

## 0.3.1

### Infrastructure

- `REQ-ENG-003`: require an architecture impact map and per-surface
  completeness evidence for shared capabilities, protocols, clients,
  persistence, migration and legacy cleanup.

## 0.3.0

### Features

- `REQ-HOST-001`: probeable host capabilities, declarative application Action
  Providers, capability graphs, composable tool packs, environment fingerprints
  and explicit degradation without a built-in generic command runner.
- `REQ-WORKSPACE-001`: integrity-checked Workspace Capsules with project,
  Session, Portable Git, Artifact, evidence and environment state; staged
  import, rollback, resume reconciliation and Node/Chrome transfer support.
- `REQ-GIT-001`: default pure-TypeScript PortableGitBackend with Git-compatible
  loose/packed objects, refs, HEAD and Index; real-Git interoperability and an
  optional CLI conformance backend.
- Headless workspace agent and candidate-aware completion guard driven only by
  declared application actions.

### Verification

- `npm run check`: 350 deterministic tests and all production builds.
- `npm run test:e2e`: 5 real Chrome extension tests.
- Real DeepSeek agent run built and committed `VOID LANCE`, a dependency-free
  WebGL 3D space combat game.
- Game gate: 76 unit/render tests and 46 validation checks.
- Migration: Node Local Host → Capsule → Chrome Portable Host ran the game,
  exported a round-trip Capsule, restored to Node, and resumed the same Session
  with a fresh passing application check.

## 0.2.1

### Documentation

- `REQ-ENG-002`: add repository-level `AGENTS.md` covering requirement ids,
  semantic versioning, design/test traceability, commit trailers, verification
  and release rules.

## 0.2.0

### Features

- `REQ-TUI-001`: rich terminal UI, native block cursor, content hierarchy,
  reasoning presentation, bounded rendering and incremental terminal frames.
- `REQ-PATCH-001`: ContextPatch editing protocol with transactional updates,
  structured diagnostics, version guards and a separate strict unified-diff tool.
- `REQ-PATCH-002`: host-neutral PatchToolPack shared by TUI, Chrome and isolated
  sandbox workspaces.
- `REQ-ENG-001`: semantic versioning, requirement registry, design/testing
  traceability, commit message validation and release policy.

### Verification

- `npm run check`
- Real DeepSeek ContextPatch smoke test
