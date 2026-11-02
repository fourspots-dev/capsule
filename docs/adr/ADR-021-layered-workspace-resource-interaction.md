# ADR-021: Layer workspace identity, paths and host interactions

- Status: proposed
- Date: 2026-11-02
- Approved by: none
- Requirements: REQ-WORKSPACE-003, REQ-HOST-004, REQ-CHROME-002, REQ-VERIFY-002
- Origin decision: DEC-015
- Supersedes: none
- Superseded by: none

## Context

Workspace files currently mix three concerns: an extension-global virtual file
system, Chrome tab/group session scope and ad-hoc browser URLs. Agent tools use
relative paths, but write results do not expose workspace identity or resource
identity. Chrome cannot navigate those paths directly. Hosts differ in how a
resource can be previewed, exported or verified, yet all of them need the same
portable semantics.

A Chrome-only `open_workspace_file` tool would make Core and ToolPacks depend on
browser concepts. Treating `open` as verification would also allow a loaded page
with failing behavior to pass completion. The decision therefore covers scope,
resource, interaction and evidence as separate contracts.

## Decision

Use four layers:

1. Portable Workspace defines stable scope and resource identity plus canonical
   POSIX-like relative paths.
2. Host interaction Ports define capability discovery, open and export intents
   without browser, terminal or native-app fields.
3. Host adapters implement those Ports using Chrome preview tabs/downloads, Node
   filesystem/editor integration, iOS document pickers, or other host APIs.
4. ToolPack, Prompt and UI expose only discovered operations using generic
   resource results and errors.

Application verification is a separate evidence concern. Opening a resource is
not sufficient evidence that an application works.

## Invariants

- Agent-visible workspace paths never contain a host scheme, absolute host path,
  `..` escape, or `file://` equivalent.
- Every file operation is bound to one `workspaceId`, generation and canonical
  path.
- Chrome label-group members share one Workspace; standalone tabs use isolated
  Workspaces.
- Core and platform contracts do not contain Chrome tab, group, window or
  download fields.
- Tool and Prompt availability is derived from the active host capability
  registry.
- `open` and `export` cannot grant permissions and do not create successful
  verification by themselves.
- A resource preview cannot be implemented by injecting source into an
  unrelated user page.
- Verification evidence is invalid when its workspace resource generation is
  stale.

## Alternatives considered

- Use one extension-global workspace: rejected because it contradicts visible
  group/standalone scope and leaks files between unrelated tasks.
- Use host absolute paths or `file://`: rejected because Chrome has no host
  filesystem mapping and paths would stop being portable.
- Create one VFS per tab: rejected because tabs inside a group intentionally
  share a Session and Workspace.
- Add only a Chrome preview Tool: rejected because TUI, Headless, iOS and future
  hosts also need open/export semantics.
- Treat successful preview as completion evidence: rejected because loading a
  page does not prove console, DOM or interaction correctness.

## Consequences

Workspace creation becomes lazy and keyed by stable scope IDs. Chrome needs a
scope-to-workspace binding store and lifecycle migration. Tool results become
larger because they identify the workspace and resource. Host adapters gain
clear open/export responsibilities. Verification needs host-specific observation
producers but a common generation-bound evidence envelope.

## Affected surfaces

- Portable Workspace identity, path normalization and resource references
- Workspace interaction Port capability registry
- Chrome TabSessionRegistry, Chrome runtime and Workspace persistence
- Browser ToolPack, workspace resource ToolPack, Prompt dynamic context
- Side Panel workspace and file-resource presentation
- CompletionGuard and evidence persistence
- TUI, Headless, iOS, Sandbox and future host adapters
- Capsule/export compatibility and migration tests

## Verification

- Path grammar and resource-identity golden tests
- Chrome group/standalone scope isolation E2E
- Host capability matrix and unavailable-capability tests
- Real Chrome preview/download E2E
- Prompt/Registry/ToolPack consistency tests
- Stale-generation and false-completion security tests
- `npm run check`, `npm run test:e2e`, and host-specific E2E gates
