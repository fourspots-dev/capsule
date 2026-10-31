import { resolve } from 'node:path';
import { OpenAIModelTransport } from '../adapters/openai-model';
import { HostSessionStore } from '../adapters/host-session-store';
import { createVirtualWorkspaceTools } from '../adapters/virtual-workspace-tools';
import type { ApprovalPort } from '../core/ports';
import { SequentialIdGenerator, systemClock } from '../core/ports';
import { PermissionModeRegistry, PolicyEngine } from '../core/policy';
import { ToolExecutor } from '../core/tool-executor';
import { WorkspaceRuntime } from '../core/workspace-runtime';
import { NodeHostBridge } from '../node/node-host';
import { runNodeTui } from '../node/run-tui';
import {
  HostViewStateStorage,
  LocalTuiRuntimePort,
  TuiApp,
  ViewStateStore,
} from '../tui';
import { VirtualWorkspace } from '../virtual';

interface TuiCliOptions {
  workspace: string;
  model: string;
  baseUrl: string;
  importProject: 'auto' | 'always' | 'never';
}

const denyPrompt: ApprovalPort = {
  requestApproval: async () => false,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey =
    process.env.DEEPSEEK_API_KEY ??
    process.env.TINYAI_API_KEY ??
    process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set DEEPSEEK_API_KEY, TINYAI_API_KEY or OPENAI_API_KEY');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('tinyai TUI requires an interactive terminal');
  }

  const host = new NodeHostBridge({
    id: 'tinyai-node-tui',
    projectRoot: resolve(options.workspace),
    terminal: { input: process.stdin, output: process.stdout, error: process.stderr },
  });
  const workspace = new VirtualWorkspace({
    host,
    storageKey: 'tinyai:workspace:v1',
    now: () => systemClock.now(),
  });
  const existing = await workspace.fs.list('', { recursive: true });
  if (
    options.importProject === 'always' ||
    (options.importProject === 'auto' && existing.length === 0)
  ) {
    const bundle = await host.workspace.importWorkspace?.();
    if (bundle) await workspace.initialize(bundle, { replace: false });
  }
  const baseline = await workspace.checkpoint('tui-baseline');

  const modes = new PermissionModeRegistry('sandbox-auto', () => systemClock.now());
  const tools = new ToolExecutor(createVirtualWorkspaceTools(workspace), denyPrompt, {
    policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
  });
  const runtime = new WorkspaceRuntime({
    model: new OpenAIModelTransport({
      baseUrl: options.baseUrl,
      apiKey,
      model: options.model,
    }),
    tools,
    clock: systemClock,
    ids: new SequentialIdGenerator(),
    sessionStore: new HostSessionStore(host.storage),
    permissionModes: modes,
    systemPrompt: [
      'You are tinyai, a coding agent operating in a portable virtual workspace.',
      'All files and commands are virtual. Use search, patch, exec and job tools.',
      `The imported project root is ${resolve(options.workspace)}; virtual paths are relative to that root.`,
      'Inspect before editing. Keep modifications small and reversible.',
      'Run relevant verification before declaring completion.',
      'Do not claim a test passed unless its tool result was observed.',
      'Final answers must summarize changes, verification evidence and unresolved risks.',
    ].join('\n'),
    maxSteps: Number(process.env.TINYAI_MAX_STEPS ?? 60),
  });

  const views = new ViewStateStore(new HostViewStateStorage(host.storage));
  const app = new TuiApp({
    runtime: new LocalTuiRuntimePort(runtime, {
      project: resolve(options.workspace).split('/').at(-1) ?? options.workspace,
      branch: process.env.TINYAI_BRANCH,
    }),
    viewState: views,
    project: resolve(options.workspace).split('/').at(-1) ?? options.workspace,
    branch: process.env.TINYAI_BRANCH,
    model: options.model,
    provider: 'virtual',
    review: async () => {
      const current = await workspace.checkpoint('tui-review');
      const diff = await workspace.diff(baseline.id, current.id);
      return {
        from: diff.from,
        to: diff.to,
        files: diff.files,
        additions: diff.files.reduce(
          (total, file) =>
            total +
            (file.patch?.split('\n').filter((line) => line.startsWith('+')).length ?? 0),
          0
        ),
        deletions: diff.files.reduce(
          (total, file) =>
            total +
            (file.patch?.split('\n').filter((line) => line.startsWith('-')).length ?? 0),
          0
        ),
        risks: [],
      };
    },
  });
  await app.initialize();
  try {
    await runNodeTui(app, host.terminal!);
  } finally {
    await runtime.dispose();
    await workspace.jobs.dispose();
  }
}

function parseArgs(args: string[]): TuiCliOptions {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (['--workspace', '--model', '--base-url', '--import'].includes(arg)) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  const imported = values.get('--import') ?? 'auto';
  if (!['auto', 'always', 'never'].includes(imported)) {
    throw new Error('--import must be auto, always or never');
  }
  return {
    workspace: resolve(values.get('--workspace') ?? positional[0] ?? process.cwd()),
    model:
      values.get('--model') ??
      process.env.TINYAI_MODEL ??
      process.env.DEEPSEEK_MODEL ??
      'deepseek-chat',
    baseUrl:
      values.get('--base-url') ??
      process.env.TINYAI_BASE_URL ??
      process.env.DEEPSEEK_BASE_URL ??
      'https://api.deepseek.com/v1',
    importProject: imported as TuiCliOptions['importProject'],
  };
}

function usage(): void {
  process.stdout.write(
    [
      'Usage: tinyai-tui [workspace] [options]',
      '',
      '  --workspace <path>   Project imported into the virtual workspace',
      '  --model <name>       OpenAI-compatible model',
      '  --base-url <url>     OpenAI-compatible base URL',
      '  --import <mode>      auto | always | never',
      '',
      'Environment: DEEPSEEK_API_KEY / TINYAI_API_KEY / OPENAI_API_KEY',
      '',
    ].join('\n')
  );
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
