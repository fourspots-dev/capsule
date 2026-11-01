# Repository Agent Instructions

These instructions are mandatory for every coding agent operating in this
repository. Read them before changing code, tests, requirements, or public
documentation.

## Sources of Truth

1. Product version: `package.json.version`.
2. Requirement state and links: `policy/requirement-registry.json`.
3. Engineering process: `docs/engineering-versioning-and-traceability.html`.
4. Requirement templates: `docs/requirements/`.
5. Commit format: `.gitmessage`.

The requirement registry uses schema version 1. Historical commits before
`e48b5b1` are legacy and must not be rewritten.

## Required Workflow

Every new feature, behavior change, security fix, refactor, or engineering
change follows this order:

1. Identify or create a requirement id.
2. Add or update its entry in `policy/requirement-registry.json`.
3. Ensure a detailed design document and detailed test-design document exist
   and are linked with precise anchors. For architecture-impacting changes,
   complete the architecture impact map before implementation.
4. Set `designStatus: "review"` and request explicit user confirmation.
5. After confirmation, set `designStatus: "approved"` and
   `implementationAuthorized: true`. Agents must not self-authorize.
6. Move the requirement to `in_progress` and implement code and tests across
   every affected surface listed by the impact map.
7. Update the requirement status and `CHANGELOG.md` when appropriate.
8. Run `npm run check` and relevant live/E2E tests.
9. Commit using the required requirement-linked message.
10. Create or move a release tag only through the release process.

Never begin a new product behavior with code while leaving it unregistered.
Documentation-only typo fixes may reference an existing engineering
requirement, but changes to contracts require updated design and test documents.

An `accepted` requirement is a reviewed problem statement, not implementation
permission. Do not change product code until the user has confirmed the detailed
design and the registry records both `designStatus: "approved"` and
`implementationAuthorized: true`.

## Requirement IDs

New requirements use:

```text
REQ-<AREA>-<NNN>
```

Examples:

```text
REQ-TUI-001
REQ-PATCH-002
REQ-ENG-001
REQ-GIT-014
```

Rules:

- IDs are globally unique and must never be reused.
- Do not rename an id after it is committed.
- Use one requirement for one independently verifiable outcome.
- A requirement spanning multiple hosts remains one requirement; host behavior
  is recorded as acceptance cases.
- After release, an incompatible extension of a requirement gets a new id and a
  supersedes relationship in its design document.
- Existing `FR-*`, `RICH-*`, and test ids remain valid legacy aliases.

Allowed requirement fields:

- `type`: `feature | bugfix | security | refactor | infrastructure | documentation`
- `priority`: `P0 | P1 | P2 | P3`
- `status`: `proposed | accepted | in_progress | implemented | verified | released`
- `designStatus`: `draft | review | approved`
- `implementationAuthorized`: boolean
- `architectureImpact`: optional boolean; `true` requires the architecture
  impact and completeness anchors.

A requirement cannot enter `in_progress` until its design and test-design links
exist, `designStatus` is `approved`, and `implementationAuthorized` is `true`.
It cannot enter `verified` without observed test evidence.

## Design and Test Documents

Every requirement must link both:

- `design`: problem, scope, non-goals, objects/interfaces, interactions, failure
  behavior, compatibility, and acceptance.
- `testDesign`: requirement trace matrix, test layers, positive/negative cases,
  failure/security cases, commands, and release gates.

Prefer these paths:

```text
docs/<area>/<REQ-ID>-design.html
docs/<area>/<REQ-ID>-testing.html
```

Related requirements may share a document only when the registry links exact
section anchors. A link to a whole document is not sufficient when a stable
section anchor exists.

Detailed design is not a feature summary. It must include:

- exact modules to add/change and modules that must remain unaware;
- public interfaces, schemas, error codes and invariants;
- object ownership and lifecycle/state machines;
- end-to-end call sequences and cancellation/recovery paths;
- persistence, migration and compatibility behavior;
- security and approval boundaries;
- rollout slices and acceptance criteria.

Detailed test design must include:

- traceability from every functional requirement to executable cases;
- concrete fixture strategy and planned test file targets;
- positive, negative, boundary, security and recovery cases;
- cross-module and cross-surface architecture tests;
- commands, evidence artifacts and release blockers.

Tests should include the requirement id in the `describe` or case name whenever
practical. Test evidence must be an observed command or artifact, not a claim.

## Architecture Change Contract

An implementation is not complete merely because one module or one entrypoint
supports the new behavior. Every shared capability, protocol, persistence model,
tool, client surface, or cross-host contract requires an architecture impact
map.

Before implementation, define and review:

1. Provider: Core, Host, Adapter, runtime service, or plugin that owns the
   implementation.
2. Consumers: every affected surface, including Headless, TUI, CLI, Chrome,
   Sandbox, Session persistence, Capsule, Prompt, ToolRegistry, Verification,
   telemetry, and future clients.
3. Lifecycle: discovery, activation, invocation, cancellation, failure,
   recovery, disposal, and version changes.
4. Persistence and migration: what is stored, exported, imported, invalidated,
   or intentionally treated as ephemeral.
5. Observable behavior: UI, Prompt, diagnostics, evidence, and degraded states.
6. Cleanup: legacy paths, duplicate implementations, hard-coded capability
   lists, and implicit fallbacks that must be removed.
7. Evidence: static fitness tests, contract tests, integration tests, real-host
   E2E, migration tests, and user-journey acceptance.

Every affected consumer must either:

- implement the change and cite its evidence; or
- document why it is out of scope and prove the platform remains correct.

Partial delivery is forbidden. Do not claim a cross-cutting capability complete
when only Headless works but TUI, Prompt, Verification, persistence, or migration
still uses the old model.

For a requirement with `architectureImpact: true`, its design link must include
`#architecture-impact` and its test link must include
`#architecture-completeness`. `npm run requirements:check` enforces both.

Use `docs/requirements/architecture-change-contract.md` as the review checklist.

## Semantic Versioning

Use strict three-part `A.B.C` versions:

- `A`: incompatible change. Reset B and C.
- `B`: backward-compatible new feature. Reset C.
- `C`: backward-compatible bugfix or small change.

Details:

- `package.json.version` is the only product version source.
- Update `package-lock.json` with `package.json`.
- One release increments exactly one segment.
- Do not bump repeatedly on every implementation commit for the same release.
- Documentation-only changes that do not alter a contract usually do not change
  the version.
- Published tags are immutable.
- Do not use dates, build ids, `latest`, or `final` as release versions.

## Commit Contract

Every commit subject uses:

```text
<type>(<REQ-ID>[,<REQ-ID>...]): <summary>
```

Allowed types:

```text
feat | fix | refactor | perf | test | docs | build | ci | chore | revert
```

A commit body must end with all trailers:

```text
Requirement: REQ-AREA-001[, REQ-AREA-002]
Version: A.B.C
Design: docs/path.html#anchor[, docs/path2.html#anchor2]
Tests: docs/path.html#test-anchor[, docs/path2.html#test-anchor2]
Test-Evidence: exact command or observable artifact
```

Example:

```text
feat(REQ-PATCH-002): make patch tools host-neutral

Extract PatchToolPack behind PatchFileSystem and reuse it from all hosts.

Requirement: REQ-PATCH-002
Version: 0.2.0
Design: docs/production-coding-agent-detailed-design.html#host-neutral-patch
Tests: docs/production-coding-agent-detailed-testing.html#patch
Test-Evidence: npm run check
```

Rules:

- `Version` must equal `package.json.version` at commit time.
- `Requirement` must match the subject scope exactly.
- Design and test trailers must resolve to existing files and anchors.
- A commit may reference multiple requirements, but it must list all designs and
  test documents.
- Do not bypass the commit hook with `--no-verify`.
- Do not rewrite pushed history or move release tags.

The repository-local hook is enabled with:

```sh
npm run hooks:install
```

## Verification and Completion

Minimum pre-commit verification:

```sh
npm run check
```

`npm run check` includes requirement traceability, type checks, Core boundary,
all deterministic tests, and production builds.

Additional evidence is required when the requirement touches:

- Real Chrome: run relevant Chrome E2E.
- Real model/tool loop: run `npm run test:live` or a documented equivalent.
- Long-running tasks: run the relevant soak or large-workspace profile.
- Security boundaries: run security/fault-injection tests.
- Cross-host contracts: verify every host adapter, not only the current client.

A feature is not complete because the code compiles or because the model says
it is complete. Completion requires acceptance evidence.

Architecture-impacting changes additionally require:

- a completed provider/consumer impact map;
- golden or contract evidence for every shared tool/schema/Prompt surface;
- an end-to-end user journey through each required client profile;
- degradation, denied, unavailable, and migration behavior;
- explicit disposition of every legacy path and fallback.

## Release Contract

Before tagging a release:

1. Confirm included requirements are `verified`.
2. Update `package.json`, `package-lock.json`, and `CHANGELOG.md`.
3. Run `npm run check`.
4. Commit with the required trailers.
5. Create an annotated tag:

```sh
git tag -a vA.B.C -m "Release A.B.C"
```

Do not create a release tag from a dirty worktree. Do not retag an existing
release. Publish a new patch/minor version for post-release fixes.

## Repository Hygiene

- Preserve unrelated user changes.
- Keep requirement, design, test, code, and commit changes in the same delivery
  slice; do not leave unregistered functional code.
- Do not remove or weaken tests to make a commit pass.
- Do not claim external tools, models, Git, browsers, or sandboxes were tested
  unless their evidence was actually observed.
- Keep generated artifacts in sync when they are tracked.
