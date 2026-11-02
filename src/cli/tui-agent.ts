import { dirname, resolve } from 'node:path';
import { OpenAIModelTransport } from '../adapters/openai-model';
import { HostArtifactStore } from '../adapters/host-artifact-store';
import { HostApprovalReceiptStore } from '../adapters/host-approval-receipt-store';
import { HostEvidenceStore } from '../adapters/host-evidence-store';
import { HostWorkspaceImportJournal } from '../adapters/host-workspace-import-journal';
import { HostSessionStore } from '../adapters/host-session-store';
import {
  NpmScriptActionProvider,
  type NpmScriptActionDefinition,
} from '../adapters/npm-action-provider';
import { RemoteToolchainProvider } from '../adapters/remote-toolchain-provider';
import { RemoteActionProvider } from '../adapters/remote-action-provider';
import { LspActionCodeIntelligence } from '../adapters/lsp-action-code-intelligence';
import { createSubagentTools } from '../adapters/subagent-tools';
import { createVirtualWorkspaceTools } from '../adapters/virtual-workspace-tools';
import { assertActionWorkspaceBinding } from '../adapters/host-action-tools';
import {
  AgentProfileRegistry,
  type PermissionPolicy,
} from '../core/agent-profile';
import type { ApprovalPort } from '../core/ports';
import { SequentialIdGenerator, systemClock } from '../core/ports';
import { HostActionRegistry } from '../platform/host-action';
import { assertHostBaseline } from '../host';
import { PermissionModeRegistry, PolicyEngine } from '../core/policy';
import { SubagentCoordinator } from '../core/subagent-coordinator';
import { ToolExecutor } from '../core/tool-executor';
import {
  TestEvidenceService,
  createTestEvidenceCompletionGuard,
} from '../evidence';
import type { JsonValue, ToolDefinition } from '../core/types';
import { WorkspaceRuntime } from '../core/workspace-runtime';
import { NodeHostBridge } from '../node/node-host';
import { NodeHostFileSystem } from '../node/host-fs';
import {
  readWorkspaceCapsuleFile,
  writeWorkspaceCapsuleFile,
} from '../node/capsule-file';
import {
  TrustedActionModuleLoader,
  type TrustedActionModuleSpec,
} from '../node/actions/trusted-module-loader';
import { PortableGitBackend } from '../git/backend';
import { runNodeTui } from '../node/run-tui';
import { WorkspaceSubagentDriver } from '../runtime/workspace-subagent-driver';
import {
  createWorkspaceCapabilityComposition,
  createWorkspaceCompletionGuard,
  type WorkspaceToolProfile,
} from '../runtime/workspace-capability-composition';
import { workspaceEditPrompt } from '../platform/workspace-edit-prompt';
import {
  HostViewStateStorage,
  LocalTuiRuntimePort,
  TuiApp,
  ViewStateStore,
} from '../tui';
import { VirtualWorkspace } from '../virtual';
import { WorkspaceContinuityService } from '../workspace/continuity';

interface TuiCliOptions {
  workspace: string;
  model: string;
  baseUrl: string;
  importProject: 'auto' | 'always' | 'never';
  workspaceMode: 'virtual' | 'host';
  toolProfile: WorkspaceToolProfile;
  approval: 'auto' | 'ask' | 'deny';
  actionScripts: NpmScriptActionDefinition[];
  actionModules: TrustedActionModuleSpec[];
  testActions: string[];
  capsuleExportPath?: string;
  importCapsule?: string;
  importMode?: 'replace' | 'merge';
}

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

  const hostFileSystem =
    options.workspaceMode === 'host'
      ? new NodeHostFileSystem(resolve(options.workspace), () => systemClock.now())
      : undefined;
  const host = new NodeHostBridge({
    id: 'tinyai-node-tui',
    projectRoot: resolve(options.workspace),
    terminal: { input: process.stdin, output: process.stdout, error: process.stderr },
    ...(hostFileSystem ? { filesystem: hostFileSystem } : {}),
  });
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
  if (
    remoteRunner &&
    options.workspaceMode === 'virtual' &&
    options.toolProfile === 'legacy'
  ) {
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
  const artifactStore = new HostArtifactStore(host.storage);
  const approvalReceipts = new HostApprovalReceiptStore(host.storage);
  const evidenceStore = new HostEvidenceStore(host.storage);
  const importJournal = new HostWorkspaceImportJournal(host.storage);
  const sessionWorkspaces = new Map<string, VirtualWorkspace>();
  const actionRegistry = new HostActionRegistry();
  if (host.actions) {
    actionRegistry.register(host.descriptor.id, host.actions);
  }
  if (options.actionScripts.length) {
    actionRegistry.register(
      'tui-application',
      new NpmScriptActionProvider({
        workspaceRoot: resolve(options.workspace),
        scripts: options.actionScripts,
      })
    );
  }
  if (options.actionModules.length) {
    const loader = new TrustedActionModuleLoader({
      allowedModules: options.actionModules,
      workspaceRoot: resolve(options.workspace),
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
  const hostBaseline = assertHostBaseline(host, 'tui-local', {
    workspaceStorage:
      options.workspaceMode === 'host' ? 'host-fs' : 'storage-backed',
    availableActions: actionReport.available,
    actionDiagnostics: actionReport.diagnostics,
  });
  const environmentFingerprint = [
    `tui-${options.workspaceMode}-${options.toolProfile}`,
    ...Object.entries(hostBaseline.tierState)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tier, state]) => `${tier}:${state}`),
  ].join('|');
  const testEvidence = new TestEvidenceService({
    store: evidenceStore,
    artifacts: artifactStore,
    vfs: workspace.fs,
    environmentFingerprint,
    workspaceGeneration: () => workspace.generation(),
  });
  const codeIntelligence = actionReport.available.some(
    (action) => action.descriptor.id === 'code.lsp.query'
  )
    ? new LspActionCodeIntelligence(actionRegistry)
    : undefined;
  const capability = await createWorkspaceCapabilityComposition({
    workspace,
    profile: options.toolProfile,
    actionRegistry,
    workspacePath: '',
    hostProfile: options.workspaceMode === 'host' ? 'local-coding' : 'portable',
    environmentFingerprint,
    hostBaseline,
    workspaceGeneration: () => workspace.generation(),
    testEvidence,
    actionBindingForInvocation: async (invocation, descriptor) => {
      const target =
        sessionWorkspaces.get(invocation.sessionId) ?? workspace;
      assertActionWorkspaceBinding(target !== workspace, descriptor);
      return {
        workspaceId: target.workspaceId,
        workspaceGeneration: await target.generation(),
        environmentFingerprint,
        evidenceVfs: target.fs,
      };
    },
    ...(codeIntelligence ? { codeIntelligence } : {}),
  });
  const actionTools = capability.actionTools;
  const applicationActions = capability.applicationActions;
  let app!: TuiApp;
  const approvalPort: ApprovalPort = {
    requestApproval: async (request, signal) => {
      if (options.approval === 'auto') return true;
      if (options.approval === 'deny') return false;
      return app.requestApproval(request, signal);
    },
  };
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
  const sessionPermissions = new Map<string, PermissionPolicy>();
  const sessionDepths = new Map<string, number>();
  const toolCache = new Map<VirtualWorkspace, ToolDefinition[]>([
    [workspace, capability.baseTools],
  ]);
  const toolsFor = (target: VirtualWorkspace): ToolDefinition[] => {
    let definitions = toolCache.get(target);
    if (!definitions) {
      definitions = createVirtualWorkspaceTools(target, {
        includeVirtualShell: options.toolProfile === 'legacy',
      });
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
  const allTools = [...routedTools, ...actionTools];
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
    [...allTools, ...subagentTools],
    approvalPort,
    {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
      approvalReceipts,
      artifacts: {
        store: artifactStore,
        thresholdBytes: 64_000,
      },
    }
  );
  runtime = new WorkspaceRuntime({
    model,
    tools,
    clock: systemClock,
    ids,
    sessionStore,
    permissionModes: modes,
    onOpen: async (sessionId) => {
      modes.get(sessionId).restore({
        mode: options.approval === 'auto' ? 'sandbox-auto' : 'guarded',
      });
    },
    completionGuard:
      options.toolProfile === 'portable'
        ? createTestEvidenceCompletionGuard({
            service: testEvidence,
            store: evidenceStore,
            actionVersions: async (actionId) =>
              (await actionRegistry.list()).find(
                (action) => action.descriptor.id === actionId
              )?.descriptor.version,
          })
        : createWorkspaceCompletionGuard(
            options.toolProfile,
            applicationActions
          ),
    systemPrompt: [capability.prompt, workspaceEditPrompt].join('\n'),
    maxSteps: Number(process.env.TINYAI_MAX_STEPS ?? 120),
  });
  const continuity = new WorkspaceContinuityService({
    workspaceId: 'tinyai-tui-workspace',
    vfs: workspace.fs,
    git: new PortableGitBackend(workspace.fs),
    sessions: sessionStore,
    artifacts: artifactStore,
    environmentId: `tui-${options.workspaceMode}-${options.toolProfile}`,
    hostProfile:
      options.workspaceMode === 'host' ? 'local-coding' : 'portable',
    agentVersion: '0.12.0',
    environment: {
      manifestVersion: 1,
      requiredActions: options.actionScripts.map((script) => ({
        id: script.id,
        versionRange: '1.0.0',
        required: false,
      })),
      requiredCapabilities: [
        'filesystem',
        'git',
        ...(options.actionScripts.length ? ['actions'] : []),
      ],
    },
    importJournal,
    evidence: () => evidenceStore.list(),
    restoreEvidence: async (records) => {
      for (const record of records) await evidenceStore.save(record);
    },
    beforeExport: async () => {
      const sessions = await runtime.listSessions();
      const active = sessions.find((session) =>
        ['queued', 'running', 'waiting'].includes(session.taskStatus)
      );
      if (active) {
        throw new Error(
          `Cannot export while Session ${active.sessionId} is ${active.taskStatus}`
        );
      }
      for (const session of sessions) {
        await runtime.flush(session.sessionId);
      }
    },
  });
  const recoveredImport = await continuity.recoverInterruptedImport();
  if (recoveredImport) {
    process.stderr.write(
      `${JSON.stringify({
        type: 'capsule_import_recovered',
        importId: recoveredImport.id,
        stage: recoveredImport.stage,
      })}\n`
    );
  }
  const exportCapsule = async () => {
    const capsule = await continuity.exportCapsule();
    const path =
      options.capsuleExportPath ??
      resolve(
        options.workspace,
        '.tinyai',
        'exports',
        `workspace-${new Date().toISOString().replace(/[:.]/g, '-')}.capsule`
      );
    await writeWorkspaceCapsuleFile(path, capsule);
    return { path };
  };
  if (options.importCapsule) {
    const capsule = await readWorkspaceCapsuleFile(options.importCapsule);
    const prepared = await continuity.prepareImport(capsule, {
      availableActions: await actionRegistry.list(),
    });
    process.stderr.write(
      `${JSON.stringify({
        type: 'capsule_import_planned',
        mode: options.importMode,
        actionsMissing: prepared.actionsMissing,
        pathChanges: prepared.pathChanges,
        sessions: prepared.sessions,
        artifactCount: prepared.artifactCount,
        evidenceCount: prepared.evidenceCount,
        environmentChanged: prepared.environmentChanged,
      })}\n`
    );
    const result = await continuity.commitImport(prepared, {
      replaceProject: options.importMode === 'replace',
    });
    process.stderr.write(
      `${JSON.stringify({
        type: 'capsule_imported',
        mode: options.importMode,
        ...result,
      })}\n`
    );
  }
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
  app = new TuiApp({
    runtime: new LocalTuiRuntimePort(runtime, {
      project: resolve(options.workspace).split('/').at(-1) ?? options.workspace,
      branch: process.env.TINYAI_BRANCH,
    }),
    viewState: views,
    project: resolve(options.workspace).split('/').at(-1) ?? options.workspace,
    branch: process.env.TINYAI_BRANCH,
    model: options.model,
    provider: [
      options.workspaceMode === 'host' ? 'host-fs' : 'virtual',
      options.toolProfile,
      applicationActions.length ? `${applicationActions.length}-actions` : 'no-actions',
    ].join('/'),
    capsuleExport: exportCapsule,
    actions: async () => {
      const report = await actionRegistry.discover();
      const available = report.inspected.map((action) => ({
        id: action.descriptor.id,
        version: action.descriptor.version,
        title: action.descriptor.title,
        description: action.descriptor.description,
        sourceId: action.sourceId,
        state: action.probe.state,
        effects: [...action.descriptor.effects],
        risk: action.descriptor.risk,
        ...(action.descriptor.limitations
          ? { limitations: [...action.descriptor.limitations] }
          : {}),
      }));
      const unavailable = report.diagnostics
        .filter(
          (diagnostic) =>
            diagnostic.actionId !== '*' &&
            !available.some((action) => action.id === diagnostic.actionId)
        )
        .map((diagnostic) => ({
          id: diagnostic.actionId,
          version: 'unknown',
          title: diagnostic.actionId,
          description: diagnostic.message,
          sourceId: diagnostic.sourceId,
          state: 'unavailable' as const,
          effects: [],
          risk: 'write' as const,
          limitations: [diagnostic.message],
        }));
      return [...available, ...unavailable].sort((left, right) =>
        left.id.localeCompare(right.id)
      );
    },
    ...(baseline
      ? {
          review: async () => {
            const current = await workspace.checkpoint('tui-review');
            const diff = await workspace.diff(baseline.id, current.id);
            const evidence = await evidenceStore.list();
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
              verification: evidence.slice(-10).map((record) => ({
                name: record.report
                  ? `${record.report.runner} ${record.report.passed}/${record.report.total}`
                  : record.action.id,
                status:
                  record.status === 'current'
                    ? ('passed' as const)
                    : record.status === 'stale' ||
                        record.status === 'invalid'
                      ? ('skipped' as const)
                      : ('failed' as const),
                detail: record.reason ?? record.status,
              })),
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
    await actionRegistry.dispose();
  }
}

function parseArgs(args: string[]): TuiCliOptions {
  const values = new Map<string, string>();
  const positional: string[] = [];
  const actionScripts: NpmScriptActionDefinition[] = [];
  const testActionIds: string[] = [];
  const actionModules: TrustedActionModuleSpec[] = [];
  let importCapsule: string | undefined;
  let importMode: 'replace' | 'merge' | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--action-script') {
      const value = args[++index];
      if (!value) throw new Error('--action-script requires id:script:title');
      const [id, script, ...title] = value.split(':');
      if (!id || !script) {
        throw new Error(`Invalid --action-script value: ${value}`);
      }
      actionScripts.push({
        id,
        script,
        title: title.join(':') || script,
        description: `Run the application npm script "${script}".`,
      });
      continue;
    }
    if (arg === '--action-module') {
      const value = args[++index];
      if (!value) throw new Error('--action-module requires an absolute path');
      actionModules.push({ path: resolve(value) });
      continue;
    }
    if (arg === '--test-action') {
      const value = args[++index];
      if (!value) throw new Error('--test-action requires an Action id');
      testActionIds.push(value);
      continue;
    }
    if (
      [
        '--workspace',
        '--model',
        '--base-url',
        '--import',
        '--workspace-mode',
        '--tool-profile',
        '--approval',
        '--capsule-export',
        '--import-capsule',
        '--import-mode',
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
  importCapsule = values.get('--import-capsule')
    ? resolve(values.get('--import-capsule')!)
    : undefined;
  const rawImportMode = values.get('--import-mode');
  if (rawImportMode && rawImportMode !== 'replace' && rawImportMode !== 'merge') {
    throw new Error('--import-mode must be replace or merge');
  }
  importMode = rawImportMode as 'replace' | 'merge' | undefined;
  if (importCapsule && !importMode) {
    throw new Error('--import-mode is required with --import-capsule');
  }
  const imported = values.get('--import') ?? 'auto';
  if (!['auto', 'always', 'never'].includes(imported)) {
    throw new Error('--import must be auto, always or never');
  }
  const workspaceMode = values.get('--workspace-mode') ?? 'virtual';
  if (!['virtual', 'host'].includes(workspaceMode)) {
    throw new Error('--workspace-mode must be virtual or host');
  }
  const toolProfile = values.get('--tool-profile') ?? 'portable';
  if (!['portable', 'legacy'].includes(toolProfile)) {
    throw new Error('--tool-profile must be portable or legacy');
  }
  const approval = values.get('--approval') ?? 'auto';
  if (!['auto', 'ask', 'deny'].includes(approval)) {
    throw new Error('--approval must be auto, ask or deny');
  }
  for (const script of actionScripts) {
    if (testActionIds.includes(script.id)) script.testRunner = script.id;
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
    toolProfile: toolProfile as WorkspaceToolProfile,
    approval: approval as TuiCliOptions['approval'],
    actionScripts,
    actionModules,
    testActions: testActionIds,
    ...(values.get('--capsule-export')
      ? { capsuleExportPath: resolve(values.get('--capsule-export')!) }
      : {}),
    ...(importCapsule ? { importCapsule } : {}),
    ...(importMode ? { importMode } : {}),
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
      '  --tool-profile       portable | legacy (default: portable)',
      '  --approval           auto | ask | deny (default: auto)',
      '  --action-script      id:script:title (repeatable)',
      '  --action-module      absolute trusted provider module (repeatable)',
      '  --test-action        Action id that emits completion TestEvidence',
      '  --capsule-export     Fixed output path for Ctrl+X Capsule export',
      '  --import-capsule     Capsule v1/v2 file to import before the TUI starts',
      '  --import-mode        replace | merge (explicit approval for import)',
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
