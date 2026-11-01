import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HostArtifactStore } from '../adapters/host-artifact-store';
import { HostSessionStore } from '../adapters/host-session-store';
import { NpmScriptActionProvider, type NpmScriptActionDefinition } from '../adapters/npm-action-provider';
import { RemoteActionProvider } from '../adapters/remote-action-provider';
import { OpenAIModelTransport } from '../adapters/openai-model';
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
import { PortableGitBackend } from '../git/backend';
import { NodeHostFileSystem } from '../node/host-fs';
import { NodeHostBridge } from '../node/node-host';
import {
  TrustedActionModuleLoader,
  type TrustedActionModuleSpec,
} from '../node/actions/trusted-module-loader';
import { HostActionRegistry } from '../platform/host-action';
import { assertHostBaseline } from '../host';
import { workspaceEditPrompt } from '../platform/workspace-edit-prompt';
import { WorkspaceSubagentDriver } from '../runtime/workspace-subagent-driver';
import {
  createWorkspaceCapabilityComposition,
  createWorkspaceCompletionGuard,
} from '../runtime/workspace-capability-composition';
import { VirtualWorkspace } from '../virtual';
import { parseWorkspaceCapsule, serializeWorkspaceCapsule } from '../workspace/codec';
import { WorkspaceContinuityService } from '../workspace/continuity';

interface WorkspaceAgentOptions {
  workspace: string;
  task: string;
  sessionId: string;
  model: string;
  baseUrl: string;
  importCapsule?: string;
  exportCapsule?: string;
  scripts: NpmScriptActionDefinition[];
  actionModules: TrustedActionModuleSpec[];
  maxSteps: number;
  approval: 'auto' | 'ask';
}

const denyApproval: ApprovalPort = {
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
  const fs = new NodeHostFileSystem(options.workspace, () => systemClock.now());
  const host = new NodeHostBridge({
    id: 'tinyai-workspace-agent',
    projectRoot: options.workspace,
    stateRoot: resolve(options.workspace, '.tinyai'),
    filesystem: fs,
  });
  const workspace = new VirtualWorkspace({
    host,
    vfs: fs,
    storageKey: 'tinyai:workspace:v1',
  });
  const git = new PortableGitBackend(fs);
  const sessions = new HostSessionStore(host.storage);
  const artifacts = new HostArtifactStore(host.storage);
  const npmActions = new NpmScriptActionProvider({
    workspaceRoot: options.workspace,
    scripts: options.scripts,
  });
  const actionRegistry = new HostActionRegistry();
  actionRegistry.register('workspace-app', npmActions);
  if (options.actionModules.length) {
    const loader = new TrustedActionModuleLoader({
      allowedModules: options.actionModules,
      workspaceRoot: options.workspace,
    });
    for (const spec of options.actionModules) {
      const loaded = await loader.load(spec.path);
      actionRegistry.register(`trusted:${loaded.id}`, loaded.provider);
    }
  }
  if (process.env.TINYAI_REMOTE_ACTIONS_URL) {
    actionRegistry.register(
      'remote-actions',
      new RemoteActionProvider({
        endpoint: process.env.TINYAI_REMOTE_ACTIONS_URL,
        ...(process.env.TINYAI_REMOTE_ACTIONS_TOKEN
          ? { token: process.env.TINYAI_REMOTE_ACTIONS_TOKEN }
          : {}),
      })
    );
  }
  const actionReport = await actionRegistry.discover();
  const hostBaseline = assertHostBaseline(host, 'sandbox', {
    workspaceStorage: 'host-fs',
    availableActions: actionReport.available,
    actionDiagnostics: actionReport.diagnostics,
  });
  const capability = await createWorkspaceCapabilityComposition({
    workspace,
    profile: 'portable',
    actionRegistry,
    workspacePath: '',
    hostProfile: 'local-coding',
    environmentFingerprint: [
      `local-${process.platform}-${process.arch}`,
      ...Object.entries(hostBaseline.tierState)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([tier, state]) => `${tier}:${state}`),
    ].join('|'),
    hostBaseline,
  });
  const actionTools = capability.actionTools;
  const applicationActions = capability.applicationActions;
  const continuity = new WorkspaceContinuityService({
    workspaceId: 'tinyai-workspace',
    vfs: fs,
    git,
    sessions,
    artifacts,
    environmentId: `local-${process.platform}-${process.arch}`,
    hostProfile: 'local-coding',
    agentVersion: '0.6.0',
    newId: () => `capsule_${randomUUID()}`,
    environment: {
      manifestVersion: 1,
      requiredActions: options.scripts.map((script) => ({
        id: script.id,
        versionRange: '1.0.0',
        required: false,
      })),
      requiredCapabilities: ['filesystem', 'git', 'actions'],
    },
  });

  if (options.importCapsule) {
    const capsule = await parseWorkspaceCapsule(
      await readFile(options.importCapsule)
    );
    const prepared = await continuity.prepareImport(capsule, {
      availableActions: await actionRegistry.list(),
    });
    await continuity.commitImport(prepared, { replaceProject: true });
  }

  const modes = new PermissionModeRegistry('sandbox-auto', () => systemClock.now());
  const ids = new SequentialIdGenerator();
  const baseTools = capability.baseTools;
  const rootPermissions: PermissionPolicy = {
    capabilities: [
      'workspace:read',
      'workspace:write',
      'workspace:execute',
      'workspace:jobs',
      'workspace:git',
      'action:invoke',
      'agent:spawn',
      'agent:manage',
    ],
    effects: ['read', 'write', 'execute'],
  };
  const profiles = new AgentProfileRegistry();
  profiles.register({
    name: 'worker',
    displayName: 'Workspace worker',
    description: 'Generic delegated coding task over an isolated workspace fork.',
    instructions:
      'Complete the delegated coding task, run the available application checks, and report concrete evidence.',
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
    maxConcurrency: 3,
  });
  const sessionWorkspaces = new Map<string, VirtualWorkspace>();
  const sessionPermissions = new Map<string, PermissionPolicy>();
  const sessionDepths = new Map<string, number>();
  const toolCache = new Map<VirtualWorkspace, ToolDefinition[]>();
  const toolsFor = (target: VirtualWorkspace): ToolDefinition[] => {
    let tools = toolCache.get(target);
    if (!tools) {
      tools = createVirtualWorkspaceTools(target, {
        includeVirtualShell: false,
      });
      toolCache.set(target, tools);
    }
    return tools;
  };
  const routedBase = toolsFor(workspace).map((definition) => ({
    ...definition,
    execute: async (input: JsonValue, invocation: Parameters<ToolDefinition['execute']>[1]) => {
      const target = sessionWorkspaces.get(invocation.sessionId) ?? workspace;
      const selected = toolsFor(target).find((item) => item.name === definition.name);
      if (!selected) throw new Error(`Workspace tool unavailable: ${definition.name}`);
      return selected.execute(input, invocation);
    },
  }));
  let runtime!: WorkspaceRuntime;
  const driver = new WorkspaceSubagentDriver({
    ids,
    disposeRuntime: false,
    forkWorkspace: async ({ parentSessionId }) =>
      (sessionWorkspaces.get(parentSessionId ?? '') ?? workspace).fork(),
    createRuntime: ({ sessionId, workspace: childWorkspace, profile }) => {
      if (childWorkspace) sessionWorkspaces.set(sessionId, childWorkspace);
      sessionPermissions.set(sessionId, profile.effectivePermissions);
      sessionDepths.set(sessionId, 1);
      return runtime;
    },
  });
  const coordinator = new SubagentCoordinator({
    registry: profiles,
    driver,
    ids,
    now: () => systemClock.now(),
    contextProvider: async (parentTaskId) => runtime.contextForTask(parentTaskId),
  });
  const subagents = createSubagentTools({
    coordinator,
    parent: (invocation) => ({
      taskId: invocation.taskId,
      depth: sessionDepths.get(invocation.sessionId) ?? 0,
      maxDepth: 2,
      permissions:
        sessionPermissions.get(invocation.sessionId) ?? rootPermissions,
    }),
  });
  const executor = new ToolExecutor(
    [
      ...routedBase.filter((tool) =>
        capability.tools.some((candidate) => candidate.name === tool.name)
      ),
      ...actionTools,
      ...subagents,
    ],
    denyApproval,
    {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
      artifacts: { store: artifacts, thresholdBytes: 64_000 },
    }
  );
  runtime = new WorkspaceRuntime({
    model: new OpenAIModelTransport({
      baseUrl: options.baseUrl,
      apiKey,
      model: options.model,
    }),
    tools: executor,
    clock: systemClock,
    ids,
    sessionStore: sessions,
    permissionModes: modes,
    maxSteps: options.maxSteps,
    completionGuard: createWorkspaceCompletionGuard(
      'portable',
      applicationActions
    ),
    systemPrompt: [capability.prompt, workspaceEditPrompt].join('\n'),
  });
  const unsubscribe = coordinator.subscribe((child) => {
    runtime.updateChildTask(child.parentTaskId, {
      taskId: child.taskId,
      sessionId: child.sessionId,
      parentTaskId: child.parentTaskId,
      ...(child.parentSessionId ? { parentSessionId: child.parentSessionId } : {}),
      profileName: child.profileName,
      status: child.status,
      executionMode: child.executionMode,
      ...(child.result?.summary ? { summary: child.result.summary } : {}),
      ...(child.completedAt ? { updatedAt: child.completedAt } : {}),
      changedFiles: child.result?.changedFiles?.length,
    });
  });

  try {
    if (options.approval === 'auto') {
      const modeAck = await runtime.command({
        commandId: `mode_${Date.now()}`,
        clientId: 'workspace-agent',
        sessionId: options.sessionId,
        type: 'set_mode',
        payload: { mode: 'sandbox-auto' },
        issuedAt: Date.now(),
      });
      if (modeAck.status !== 'accepted') {
        throw new Error(modeAck.error?.message ?? `Mode command ${modeAck.status}`);
      }
    }
    const ack = await runtime.command({
      commandId: `agent_${Date.now()}`,
      clientId: 'workspace-agent',
      sessionId: options.sessionId,
      type: 'send_input',
      payload: { text: options.task },
      issuedAt: Date.now(),
    });
    if (ack.status !== 'accepted') {
      throw new Error(ack.error?.message ?? `Command ${ack.status}`);
    }
    await runtime.waitForSessionIdle(options.sessionId);
    const projection = runtime.getProjection(options.sessionId);
    for (const row of projection.rows) {
      if (row.kind === 'tool') {
        process.stderr.write(`[tool:${row.toolName ?? 'unknown'}] ${row.status}\n`);
      }
    }
    const answer = [...projection.rows]
      .reverse()
      .find((row) => row.kind === 'assistant' && row.text.trim())?.text;
    if (answer) process.stdout.write(`${answer}\n`);
    if (projection.taskStatus !== 'completed') {
      throw new Error(projection.lastError?.message ?? `Task ${projection.taskStatus}`);
    }
    if (options.exportCapsule) {
      const capsule = await continuity.exportCapsule();
      await import('node:fs/promises').then(({ writeFile }) =>
        writeFile(options.exportCapsule!, serializeWorkspaceCapsule(capsule))
      );
    }
  } finally {
    unsubscribe();
    await coordinator.dispose();
    await runtime.dispose();
    await workspace.jobs.dispose();
    await actionRegistry.dispose();
  }
}

function parseArgs(args: string[]): WorkspaceAgentOptions {
  const values = new Map<string, string>();
  const scriptSpecs: string[] = [];
  const actionModules: TrustedActionModuleSpec[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--script') {
      const value = args[++index];
      if (!value) throw new Error('--script requires id:script:title');
      scriptSpecs.push(value);
      continue;
    }
    if (arg === '--action-module') {
      const value = args[++index];
      if (!value) throw new Error('--action-module requires a path');
      actionModules.push({ path: resolve(value) });
      continue;
    }
    if (
      arg === '--workspace' ||
      arg === '--task' ||
      arg === '--session' ||
      arg === '--model' ||
      arg === '--base-url' ||
      arg === '--import-capsule' ||
      arg === '--export-capsule' ||
      arg === '--max-steps' ||
      arg === '--approval'
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  const workspace = resolve(values.get('--workspace') ?? process.cwd());
  const task = values.get('--task')?.trim();
  if (!task) throw new Error('--task is required');
  const scripts = scriptSpecs.map((spec) => {
    const [id, script, ...title] = spec.split(':');
    if (!id || !script) throw new Error(`Invalid --script value: ${spec}`);
    return {
      id,
      script,
      title: title.join(':') || script,
      description: `Run the application npm script "${script}".`,
    };
  });
  return {
    workspace,
    task,
    sessionId: values.get('--session') ?? 'workspace-agent',
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
    ...(values.get('--import-capsule')
      ? { importCapsule: resolve(values.get('--import-capsule')!) }
      : {}),
    ...(values.get('--export-capsule')
      ? { exportCapsule: resolve(values.get('--export-capsule')!) }
      : {}),
    scripts,
    actionModules,
    maxSteps: Number(values.get('--max-steps') ?? 120),
    approval:
      values.get('--approval') === 'ask'
        ? 'ask'
        : values.get('--approval') === 'auto'
          ? 'auto'
          : (process.env.TINYAI_APPROVAL === 'ask' ? 'ask' : 'auto'),
  };
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
