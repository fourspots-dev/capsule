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
3. Ensure a design document and test-design document exist and are linked with
   precise anchors.
4. Implement code and tests.
5. Update the requirement status and `CHANGELOG.md` when appropriate.
6. Run `npm run check` and relevant live/E2E tests.
7. Commit using the required requirement-linked message.
8. Create or move a release tag only through the release process.

Never begin a new product behavior with code while leaving it unregistered.
Documentation-only typo fixes may reference an existing engineering
requirement, but changes to contracts require updated design and test documents.

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

A requirement cannot enter `in_progress` until its design and test-design links
exist. It cannot enter `verified` without observed test evidence.

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

Tests should include the requirement id in the `describe` or case name whenever
practical. Test evidence must be an observed command or artifact, not a claim.

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
