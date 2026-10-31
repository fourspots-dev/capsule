# Changelog

## Unreleased

### Planned

- `REQ-HOST-001`: proposed host capability ports, runtime probes, composable
  workspace tool packs, profile-driven degradation and matching test design.
- `REQ-WORKSPACE-001`: proposed portable workspace capsule for cross-host
  session, project, repository, artifact, evidence and environment continuity.
- `REQ-HOST-001`: clarify WorkspacePath, transport, environment fingerprint and
  ephemeral-resource boundaries required by the workspace capsule.
- `REQ-HOST-001`: replace the generic execution baseline with declarative,
  probeable application Action Providers; test/build/browser capabilities are
  registered only by the embedding application.
- `REQ-GIT-001`: proposed a default pure-TypeScript PortableGitBackend with a
  common local Git subset and Git-compatible objects, refs, HEAD and index;
  the CLI backend remains optional.

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
