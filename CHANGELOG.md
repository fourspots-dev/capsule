# Changelog

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
