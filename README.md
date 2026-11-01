# tinyai

## Engineering governance

Release versions use `A.B.C`: major for incompatible changes, minor for new
features and patch for small changes or bug fixes. Every new requirement gets a
unique `REQ-<AREA>-<NNN>` id and must link both a design section and a test
design section.

- Policy: [`docs/engineering-versioning-and-traceability.html`](docs/engineering-versioning-and-traceability.html)
- Agent instructions: [`AGENTS.md`](AGENTS.md)
- Registry: [`policy/requirement-registry.json`](policy/requirement-registry.json)
- Templates: [`docs/requirements/`](docs/requirements/)
- Validate registry: `npm run requirements:check`
- Install commit enforcement: `npm run hooks:install`

Commits use `type(REQ-ID): summary` and trail a matching requirement, version,
design path, test path and test evidence. See the policy document and
`.gitmessage` for the exact format.

tinyai is a browser agent that runs in Chrome/Edge and a local coding agent that runs in a restricted macOS Seatbelt workspace.

The extension uses one product UI and one authoritative runtime. It no longer includes the old side-panel runtime.

## Install

Build and load the extension:

```bash
npm install
npm run build
```

Then:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked**.
4. Select `/Users/jiaoxiang/ai/clj/clj-agent/extension`.

The packaged extension is also available at:

```text
dist/tinyai-extension.zip
```

Chrome does not install ZIP files directly; extract the ZIP and load the extracted `extension/` directory.

## Configure a model

Open the extension side panel, select Settings, and enter an OpenAI-compatible connection:

```text
Base URL: https://api.deepseek.com/v1
Model:    deepseek-chat
API key:  your key
```

The key is stored locally in `chrome.storage.local`. It is sent only to the configured model endpoint.

## Browser UI

The UI follows the original tinyai visual language:

- Compact top navigation.
- Right-aligned user bubbles and plain-text assistant answers.
- Collapsible tool steps.
- A single bottom composer dock.
- Live Thinking status with elapsed time.
- Inline Plan, Compaction, approval, and manual handoff cards.
- Compact subagent rows with a `View` entry into the child session.
- Artifact viewer for screenshots, PDFs, and large tool output.

The UI consumes only `Command` and `ProductProjection`. Runtime state is not reconstructed from rendered messages.

The UI design and its test strategy are maintained in:

- [UI detailed design](docs/tinyai-ui-design-v1.html)
- [UI test design](docs/tinyai-ui-testing-v1.html)

## Runtime

```text
Chrome Side Panel
  -> RuntimeClient
  -> background RuntimeGateway
  -> WorkspaceRuntime
       -> SessionLifecycle
       -> CommandInbox / InputLedger
       -> AgentLoop
            -> ModelGateway
            -> ToolExecutor
       -> SessionTree / Compaction
       -> EventLog
       -> ProductProjection
```

Key capabilities:

- Idempotent Command/ACK and revision validation.
- Durable accepted input and cold hydration.
- FIFO task queue, stop, restart, and resource cleanup.
- Event-driven AgentLoop with steering, follow-ups, parallel tool batches, and abort.
- SessionTree branches, context edits, compaction, and one-shot overflow recovery.
- Closed snapshot/delta Projection protocol with gap resync.
- Model retry/fallback and real OpenAI-compatible streaming.
- Generic `AgentProfile` and `ChildTaskSpec` subagents.
- Skills, MCP over HTTP, declarative hooks, profiles, themes, and artifacts.

## Browser tools

The BrowserProvider supports:

- Tabs and per-session tab groups.
- CDP debugger attach/detach.
- Frame discovery and frame-scoped accessibility snapshots.
- AX snapshots with stable `@eN` refs.
- CSS selector and accessibility ref interactions.
- Real mouse click, hover, drag, keyboard, fill, select, scroll, and wait.
- Dialog handling, network capture, uploads, screenshots, PDF, and downloads.
- Session tab cleanup on stop/restart.

## Subagents

Subagents are configuration-driven. The runtime contains no fixed Researcher/Reviewer role enum.

Supported operations:

```text
spawn_agent
send_message
wait_agent
stop_agent
list_agents
```

Profiles can define tools, skills, MCP servers, permissions, model policy, context mode, execution mode, concurrency, depth, and result schema.

Child permissions are the intersection of parent and profile permissions. `fork` context is explicit; `fresh` does not expose parent conversation.

## Coding Agent CLI

macOS uses the built-in Seatbelt sandbox by default:

```bash
export DEEPSEEK_API_KEY='...'

node dist/tinyai-coding-agent.cjs \
  --workspace /path/to/project \
  --sandbox local \
  --task 'implement the requested change and verify it'
```

Docker is optional:

```bash
node dist/tinyai-coding-agent.cjs \
  --workspace /path/to/project \
  --sandbox docker \
  --task 'implement and verify'
```

The local sandbox:

- Restricts writes to the selected workspace.
- Denies network access.
- Blocks sensitive home directories.
- Rejects symlink/path escapes.
- Supports command timeout, PTY, checkpoint, and restore.
- Runs project `typecheck` and `test` scripts as a completion gate.

## Portable TUI

`tinyai-tui` runs the V2 virtual Workspace architecture. The project is imported
as an opaque bundle, edits and commands go through the built-in VFS and Virtual
Shell, and only the host Terminal/Storage bridges are required.

```bash
export DEEPSEEK_API_KEY='...'
node dist/tinyai-tui.cjs --workspace /path/to/project
```

For very large existing repositories, use the optional fenced host filesystem
instead of importing a virtual copy:

```bash
node dist/tinyai-tui.cjs --workspace /path/to/large-repo --workspace-mode host
```

`host` mode uses `NodeHostFileSystem` byte-range reads and still rejects paths or
symlinks outside the selected project root. VFS remains the default.

Every TUI/Headless startup runs the shared Host Baseline probe. Core, Workspace
and Portable Coding are mandatory; missing executable Actions only degrades Real
Execution and never disables Portable Git, Patch, Search or file editing.

Application operations are exposed as named Actions:

```bash
node dist/tinyai-tui.cjs --workspace ./app \
  --action-script app.test:test:"Run application tests" \
  --test-action app.test \
  --approval ask

node dist/tinyai-tui.cjs --workspace ./app \
  --action-module /absolute/trusted/action-provider.mjs \
  --approval ask
```

`--action-module` accepts only explicitly configured absolute modules and never
auto-loads provider code from the workspace. Local Actions use an executable
allowlist, argv without a shell, a fenced cwd, a compact environment, bounded
output, timeout and process-tree cancellation.

Remote named Actions can be configured without adding a generic command tool:

```bash
export TINYAI_REMOTE_ACTIONS_URL='https://actions.example/v1'
export TINYAI_REMOTE_ACTIONS_TOKEN='...'
```

`--approval ask` shows a blocking TUI prompt for dangerous Actions. Enter
approves the current input/environment digest; Escape denies it.

Only Actions marked with `--test-action` produce completion evidence. A task
cannot complete without a current TestReport whose file hashes, Workspace
generation, environment fingerprint and Action version still match. Zero tests,
malformed reports and failures without Artifacts are rejected. Portable test
discovery is exposed through the read-only `discover_tests` tool.

Use `Ctrl+Y` to inspect the read-only Action Manager, including available,
degraded and unavailable Actions with version, effects, risk and limitations.

Code intelligence is exposed through `code_capabilities`, `code_diagnostics`,
`code_symbols`, `code_definition`, `code_references` and `code_actions`.
Without an LSP provider, tinyai uses an explicitly degraded portable
text/symbol index. Register an Action named `code.lsp.query` to supply semantic
diagnostics, definitions, references and WorkspaceEdit proposals.

Capsules are exported as compressed, chunked and content-addressed Capsule v2;
v1 capsules remain importable:

```bash
node dist/tinyai-tui.cjs --workspace ./restored \
  --import-capsule ./workspace.capsule \
  --import-mode replace
```

`replace` or `merge` is required before import. The preflight plan reports
sessions, evidence, artifacts, missing Actions and per-path changes.

The default screen contains one status line, the conversation and the composer.
Useful keys:

```text
Enter          send
Shift+Enter    newline (Ctrl+J fallback)
Ctrl+K         sessions
Ctrl+G         agent board
Ctrl+Y         application Actions
Ctrl+I         full runtime status
Ctrl+O         workspace diff review
Ctrl+C         stop, or press twice while idle to exit
Esc            return
```

Build only the TUI with `npm run build:tui`. The output is
`dist/tinyai-tui.cjs`.

## Optional Remote Runner

When a host has no local toolchain, `RemoteToolchainProvider` can send the
virtual project bundle to a runner, execute an allowlisted command, and apply
the returned Workspace bundle.

```bash
TINYAI_RUNNER_TOKEN='...' \
TINYAI_RUNNER_COMMANDS='node,npm,python3,git' \
node dist/tinyai-remote-runner.cjs
```

Point the TUI at it with:

```bash
export TINYAI_REMOTE_RUNNER_URL='http://127.0.0.1:8787'
export TINYAI_REMOTE_RUNNER_TOKEN='...'
export TINYAI_REMOTE_RUNNER_COMMANDS='node,npm,python3,git'
```

## Tests

```bash
npm run typecheck
npm run typecheck:tests
npm test
npm run test:e2e
npm run check
```

The suites cover L0-L2 deterministic tests, real macOS Seatbelt execution, and real Chrome extension E2E. A live DeepSeek smoke test can be enabled with:

```bash
export DEEPSEEK_API_KEY='...'
npm test -- --run tests/live/deepseek-smoke.test.ts
unset DEEPSEEK_API_KEY
```

The V2 phase-by-phase acceptance matrix is documented in
[V2 implementation acceptance](docs/virtual-workspace-agent-acceptance-v2.html).

Long-running production soak is opt-in:

```bash
npm run test:soak
npm run test:soak:8h
npm run test:soak:equivalent
```

The 8-hour profile defaults to one workload cycle per second. For a shorter
smoke run, set `TINYAI_SOAK_DURATION_MS` and optionally
`TINYAI_SOAK_INTERVAL_MS`. The equivalent profile runs the same 28,800 workload
cycles with a shortened interval while the wall-clock profile remains available
for release gates.

Large-workspace acceptance uses the optional native `HostFileSystem` provider,
which performs fenced byte-range reads instead of loading the whole project:

```bash
npm run test:large
npm run test:large:1gb
```

## Compatibility migration

On first startup, tinyai performs a one-time migration from the removed legacy runtime:

```text
clj-agent-config   -> tinyai:v2:config
clj-agent-skills   -> tinyai:v1:skills
agent_skills       -> tinyai:v1:skills
clj-agent-sessions -> tinyai:session:v1:<sessionId>
```

Successful migration removes the old keys. The migration adapter can be removed after the supported upgrade window.

## Security

- The Side Panel never executes host shell commands.
- Browser actions use Chrome-authorized tabs/debugger APIs.
- Coding commands run through a SandboxProvider.
- The local sandbox permits writes only in the workspace.
- Network is denied unless an explicitly configured provider allows it.
- Model credentials are never included in Projection, EventLog, or Artifacts.

## Layout

```text
src/
  core/        domain, runtime, projection, profiles, tools, sandbox contracts
  adapters/    Chrome, OpenAI, MCP, skills, artifacts, Docker, sessions
  runtime/     gateway, composition, prompts, storage migration
  sidepanel/   unified UI and RuntimeClient
  node/        local sandbox, process runner, allowlist proxy
  cli/         coding-agent entrypoint
tests/
  unit/
  integration/
  adapters/
  node/
  e2e/
  live/
```

Implementation status is recorded in [the implementation plan](docs/tinyai-implementation-plan-v1.html) and [completion audit](docs/tinyai-completion-audit-v1.html).
