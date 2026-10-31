import { resolve } from 'node:path';
import { OpenAIModelTransport } from '../adapters/openai-model';
import { HostSessionStore } from '../adapters/host-session-store';
import { RemoteToolchainProvider } from '../adapters/remote-toolchain-provider';
import { createSubagentTools } from '../adapters/subagent-tools';
import { createVirtualWorkspaceTools } from '../adapters/virtual-workspace-tools';
import {
  AgentProfileRegistry,
  type PermissionPolicy,
} from '../core/agent-profile';
import type { ApprovalPort } from '../core/ports';
import { SequentialIdGenerator, systemClock } from '../core/ports';
import { PermissionModeRegistry, PolicyEngine } from '../core/policy';
import { SubagentCoordinator } from '../core/subagent-coordinator';
import { ToolExecutor } from '../core/tool-executor';
import type { JsonValue, ToolDefinition } from '../core/types';
import { WorkspaceRuntime } from '../core/workspace-runtime';
import { NodeHostBridge } from '../node/node-host';
import { NodeHostFileSystem } from '../node/host-fs';
import { runNodeTui } from '../node/run-tui';
import { WorkspaceSubagentDriver } from '../runtime/workspace-subagent-driver';
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
  workspaceMode: 'virtual' | 'host';
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
  const hostFileSystem =
    options.workspaceMode === 'host'
      ? new NodeHostFileSystem(resolve(options.workspace), () => systemClock.now())
      : undefined;
  const workspace = new VirtualWorkspace({
    host,
    ...(hostFileSystem ? { vfs: hostFileSystem } : {}),
    storageKey: 'tinyai:workspace:v1',
    now: () => systemClock.now(),
  });
  if (options.workspaceMode === 'virtual') {
    const existing = await workspace.fs.list('', { recursive: true });
    if (
      options.importProject === 'always' ||
      (options.importProject === 'auto' && existing.length === 0)
    ) {
      const bundle = await host.workspace.importWorkspace?.();
      if (bundle) await workspace.initialize(bundle, { replace: false });
    }
    await workspace.sync.captureBaseline(await workspace.exportBundle());
  }
  const baseline =
    options.workspaceMode === 'virtual'
      ? await workspace.checkpoint('tui-baseline')
      : undefined;
  const remoteRunner = process.env.TINYAI_REMOTE_RUNNER_URL;
  if (remoteRunner && options.workspaceMode === 'virtual') {
    workspace.shell.addProvider(
      new RemoteToolchainProvider({
        endpoint: remoteRunner,
        ...(process.env.TINYAI_REMOTE_RUNNER_TOKEN
          ? { token: process.env.TINYAI_REMOTE_RUNNER_TOKEN }
          : {}),
        workspace: workspace.fs,
        ...(process.env.TINYAI_REMOTE_RUNNER_COMMANDS
          ? {
              commandAllowlist: process.env.TINYAI_REMOTE_RUNNER_COMMANDS
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : {}),
      })
    );
  }

  const modes = new PermissionModeRegistry('sandbox-auto', () => systemClock.now());
  const ids = new SequentialIdGenerator();
  const sessionStore = new HostSessionStore(host.storage);
  const model = new OpenAIModelTransport({
    baseUrl: options.baseUrl,
    apiKey,
    model: options.model,
  });
  const rootPermissions: PermissionPolicy = {
    capabilities: [
      'workspace:read',
      'workspace:write',
      'workspace:execute',
      'workspace:jobs',
      'agent:spawn',
      'agent:manage',
    ],
    effects: ['read', 'write', 'execute'],
  };
  const profiles = new AgentProfileRegistry();
  profiles.register({
    name: 'worker',
    displayName: 'Virtual workspace worker',
    description: 'A generic delegated coding task operating on an isolated workspace fork.',
    instructions:
      'Work only from the delegated brief. Inspect the fork, make focused changes, run relevant verification, and report evidence plus unresolved items.',
    source: 'builtin',
    skills: [],
    tools: {},
    mcpServers: [],
    permissions: {
      capabilities: [...rootPermissions.capabilities],
      effects: [...rootPermissions.effects],
    },
    contextMode: 'fresh',
    execution: {
      defaultMode: 'background',
      allowedModes: ['foreground', 'background', 'isolated-worktree'],
    },
    maxDepth: 2,
    maxConcurrency: 4,
  });
  const sessionWorkspaces = new Map<string, VirtualWorkspace>();
  const sessionPermissions = new Map<string, PermissionPolicy>();
  const sessionDepths = new Map<string, number>();
  const toolCache = new Map<VirtualWorkspace, ToolDefinition[]>();
  const toolsFor = (target: VirtualWorkspace): ToolDefinition[] => {
    let definitions = toolCache.get(target);
    if (!definitions) {
      definitions = createVirtualWorkspaceTools(target);
      toolCache.set(target, definitions);
    }
    return definitions;
  };
  const routedTools = toolsFor(workspace).map((definition) => ({
    ...definition,
    execute: async (input: JsonValue, invocation: Parameters<ToolDefinition['execute']>[1]) => {
      const target = sessionWorkspaces.get(invocation.sessionId) ?? workspace;
      const selected = toolsFor(target).find((item) => item.name === definition.name);
      if (!selected) throw new Error(`Virtual tool unavailable: ${definition.name}`);
      return selected.execute(input, invocation);
    },
  }));
  let runtime!: WorkspaceRuntime;
  const driver = new WorkspaceSubagentDriver({
    ids,
    disposeRuntime: false,
    async forkWorkspace({ parentSessionId, spec }) {
      const parent =
        sessionWorkspaces.get(parentSessionId ?? '') ?? workspace;
      const child = await parent.fork();
      return child;
    },
    createRuntime: ({ sessionId, workspace: childWorkspace, profile, spec }) => {
      if (childWorkspace) {
        sessionWorkspaces.set(sessionId, childWorkspace);
        sessionDepths.set(sessionId, 1);
      }
      sessionPermissions.set(sessionId, profile.effectivePermissions);
      return runtime;
    },
  });
  const coordinator = new SubagentCoordinator({
    registry: profiles,
    driver,
    ids,
    now: () => systemClock.now(),
    contextProvider: async (parentTaskId) =>
      runtime.contextForTask(parentTaskId),
  });
  const subagentTools = createSubagentTools({
    coordinator,
    parent: (invocation) => ({
      taskId: invocation.taskId,
      depth: sessionDepths.get(invocation.sessionId) ?? 0,
      maxDepth: 2,
      permissions:
        sessionPermissions.get(invocation.sessionId) ??
        rootPermissions,
    }),
  });
  const tools = new ToolExecutor(
    [...routedTools, ...subagentTools],
    denyPrompt,
    {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
    }
  );
  runtime = new WorkspaceRuntime({
    model,
    tools,
    clock: systemClock,
    ids,
    sessionStore,
    permissionModes: modes,
    completionGuard: ({ view }) => {
      const wrote = view.rows.some(
        (row) =>
          row.kind === 'tool' &&
          ['write_file', 'apply_patch', 'apply_unified_diff', 'delete_file'].includes(
            row.toolName ?? ''
          ) &&
          row.status === 'completed'
      );
      const verified = view.rows.some(
        (row) =>
          row.kind === 'tool' &&
          ['exec', 'job_read'].includes(row.toolName ?? '') &&
          row.status === 'completed'
      );
      return wrote && !verified
        ? {
            ok: false,
            reason:
              'Files changed but no successful exec/job_read verification was observed',
          }
        : { ok: true };
    },
    systemPrompt: [
      'You are tinyai, a coding agent operating in a portable virtual workspace.',
      'All files and commands are virtual. Use search, patch, exec and job tools.',
      'The Virtual Shell only provides builtins: true, false, set, pwd, echo, printf, uname, which, command, env, export, cd, ls, cat, touch, mkdir, rm, cp, mv, grep, rg, head, tail, wc, find, diff, patch and test.',
      'Do not try to run node, npm, python, bash, git, sed, awk, uname from the host, /usr/bin paths or host package managers. They are intentionally unavailable.',
      'Use write_file for complete rewrites, replace_in_file for small exact edits, and append_file for appending. Use apply_patch with the contextual *** Begin Patch / *** Update File / *** Add File / *** Delete File / *** End Patch syntax. Every Update hunk begins with @@ or @@ anchor text; context lines start with a space, removals with -, additions with +. Do not calculate @@ line counts or send ---/+++ headers. apply_unified_diff is only for strict Git unified diffs.',
      'read_file offset and length are byte offsets. Prefer start_line/end_line for line-oriented inspection.',
      `The imported project root is ${resolve(options.workspace)}; virtual paths are relative to that root.`,
      'Inspect before editing. Keep modifications small and reversible.',
      'Run relevant verification before declaring completion.',
      'Do not claim a test passed unless its tool result was observed.',
      'Final answers must summarize changes, verification evidence and unresolved risks.',
    ].join('\n'),
    maxSteps: Number(process.env.TINYAI_MAX_STEPS ?? 120),
  });
  const unsubscribeChildren = coordinator.subscribe((child) => {
    runtime.updateChildTask(child.parentTaskId, {
      taskId: child.taskId,
      sessionId: child.sessionId,
      parentTaskId: child.parentTaskId,
      ...(child.parentSessionId
        ? { parentSessionId: child.parentSessionId }
        : {}),
      profileName: child.profileName,
      status: child.status,
      executionMode: child.executionMode,
      ...(child.result?.summary ? { summary: child.result.summary } : {}),
      ...(child.completedAt ? { updatedAt: child.completedAt } : {}),
      changedFiles: child.result?.changedFiles?.length,
    });
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
    provider: options.workspaceMode === 'host' ? 'host-fs' : 'virtual',
    ...(baseline
      ? {
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
        }
      : {}),
    agentWorkspace: {
      async previewMerge(taskId) {
        const preview = await coordinator.previewMerge(taskId);
        return {
          from: 'child-fork',
          to: preview.workspaceId ?? taskId,
          files: preview.changes,
          additions: preview.changes.reduce(
            (total, file) =>
              total +
              (file.patch?.split('\n').filter((line) => line.startsWith('+')).length ?? 0),
            0
          ),
          deletions: preview.changes.reduce(
            (total, file) =>
              total +
              (file.patch?.split('\n').filter((line) => line.startsWith('-')).length ?? 0),
            0
          ),
          risks: preview.conflicts.map(
            (conflict) => `${conflict.path}: ${conflict.reason}`
          ),
        };
      },
      async applyMerge(taskId) {
        await coordinator.applyMerge(taskId);
      },
    },
  });
  await app.initialize();
  try {
    await runNodeTui(app, host.terminal!);
  } finally {
    unsubscribeChildren();
    await coordinator.dispose();
    await runtime.dispose();
    await workspace.jobs.dispose();
  }
}

function parseArgs(args: string[]): TuiCliOptions {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      [
        '--workspace',
        '--model',
        '--base-url',
        '--import',
        '--workspace-mode',
      ].includes(arg)
    ) {
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
  const workspaceMode = values.get('--workspace-mode') ?? 'virtual';
  if (!['virtual', 'host'].includes(workspaceMode)) {
    throw new Error('--workspace-mode must be virtual or host');
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
    workspaceMode: workspaceMode as TuiCliOptions['workspaceMode'],
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
      '  --workspace-mode     virtual | host (host uses fenced range-read FS)',
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
