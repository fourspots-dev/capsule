import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHostActionTools } from '../adapters/host-action-tools';
import { HostArtifactStore } from '../adapters/host-artifact-store';
import { HostSessionStore } from '../adapters/host-session-store';
import { NpmScriptActionProvider, type NpmScriptActionDefinition } from '../adapters/npm-action-provider';
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
import { HostActionRegistry } from '../platform/host-action';
import { CapabilityGraph } from '../platform/capability';
import { ToolPackComposer } from '../platform/tool-pack';
import { workspaceEditPrompt } from '../platform/workspace-edit-prompt';
import { WorkspaceSubagentDriver } from '../runtime/workspace-subagent-driver';
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
  const host = new NodeHostBridge({
    id: 'tinyai-workspace-agent',
    projectRoot: options.workspace,
    stateRoot: resolve(options.workspace, '.tinyai'),
  });
  const fs = new NodeHostFileSystem(options.workspace, () => systemClock.now());
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
  const actionTools = await createHostActionTools(actionRegistry, {
    workspacePath: '',
  });
  const capabilityGraph = new CapabilityGraph();
  capabilityGraph.setEnvironmentFingerprint(
    `local-${process.platform}-${process.arch}`
  );
  capabilityGraph.register({
    id: 'filesystem',
    version: '1',
    state: 'available',
    limitations: [],
  });
  capabilityGraph.register({
    id: 'git',
    version: '1',
    state: 'available',
    limitations: ['portable-common-subset'],
  });
  capabilityGraph.register({
    id: 'actions',
    version: '1',
    state: actionTools.length > 1 ? 'available' : 'unavailable',
    limitations: actionTools.length > 1 ? [] : ['No actions configured'],
  });
  const continuity = new WorkspaceContinuityService({
    workspaceId: 'tinyai-workspace',
    vfs: fs,
    git,
    sessions,
    artifacts,
    environmentId: `local-${process.platform}-${process.arch}`,
    hostProfile: 'local-coding',
    agentVersion: '0.3.0',
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
  const baseTools = createVirtualWorkspaceTools(workspace, {
    includeVirtualShell: false,
  });
  const toolPackComposer = new ToolPackComposer();
  toolPackComposer.register({
    id: 'workspace-coding',
    requiredCapabilities: ['filesystem', 'git'],
    tools: baseTools,
  });
  toolPackComposer.register({
    id: 'application-actions',
    requiredCapabilities: ['actions'],
    tools: actionTools,
  });
  const composition = toolPackComposer.compose(capabilityGraph);
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
        composition.tools.some((candidate) => candidate.name === tool.name)
      ),
      ...composition.tools.filter((tool) =>
        actionTools.some((candidate) => candidate.name === tool.name)
      ),
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
    completionGuard: ({ view }) => {
      if (actionTools.length <= 1) return { ok: true };
      let lastWrite = -1;
      let lastCheck = -1;
      view.rows.forEach((row, index) => {
        if (
          row.kind === 'tool' &&
          row.status === 'completed' &&
          ['write_file', 'replace_in_file', 'append_file', 'apply_patch', 'apply_unified_diff', 'delete_file', 'git_commit'].includes(
            row.toolName ?? ''
          )
        ) {
          lastWrite = index;
        }
        if (
          row.kind === 'tool' &&
          row.status === 'completed' &&
          row.toolName?.startsWith('action_')
        ) {
          lastCheck = index;
        }
      });
      return lastWrite >= 0 && lastCheck <= lastWrite
        ? {
            ok: false,
            reason:
              'Files changed after the last successful application action check',
          }
        : { ok: true };
    },
    systemPrompt: [
      'You are tinyai operating in a portable coding workspace.',
      'Use workspace-relative paths only. The .git directory is managed by git_* tools.',
      'Use git_init/git_status/git_add/git_commit/git_log as needed.',
      'Use list_host_actions to inspect application-provided actions.',
      'There is no generic shell. Run checks only through a registered action; do not invent an exec tool.',
      'Build the requested application completely and verify concrete behavior.',
      'Do not claim a check passed unless its action result was observed.',
      workspaceEditPrompt,
    ].join('\n'),
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
  }
}

function parseArgs(args: string[]): WorkspaceAgentOptions {
  const values = new Map<string, string>();
  const scriptSpecs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--script') {
      const value = args[++index];
      if (!value) throw new Error('--script requires id:script:title');
      scriptSpecs.push(value);
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
