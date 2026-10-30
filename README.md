# tinyai

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
