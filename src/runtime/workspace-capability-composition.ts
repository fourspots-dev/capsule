import { createHostActionTools } from '../adapters/host-action-tools';
import { createVirtualWorkspaceTools } from '../adapters/virtual-workspace-tools';
import type { CompletionGuard } from '../core/session-runtime';
import type {
  SessionView,
  ToolDefinition,
  ToolInvocation,
} from '../core/types';
import { CapabilityGraph } from '../platform/capability';
import type { HostActionRegistry } from '../platform/host-action';
import type { HostActionDescriptor } from '../platform/host-action';
import type { ActionWorkspaceBinding } from '../adapters/host-action-tools';
import type { HostBaselineReport } from '../host';
import type { TestEvidenceService } from '../evidence';
import { ToolPackComposer } from '../platform/tool-pack';
import type { CodeIntelligencePort } from '../platform/code-intelligence';
import type { VirtualWorkspace } from '../virtual';
import { TextCodeIntelligence } from '../intelligence/text-index';
import { createCodeIntelligenceTools } from './code-intelligence-toolpack';
import { createWorkspaceResourceTools } from './workspace-resource-toolpack';
import type { WorkspaceInteractionProvider } from '../platform/workspace-interaction';
import type { WorkspaceApplicationObservation } from '../platform/workspace-interaction';

export type WorkspaceToolProfile = 'portable' | 'legacy';

export interface WorkspaceCapabilityCompositionOptions {
  workspace: VirtualWorkspace;
  profile: WorkspaceToolProfile;
  actionRegistry?: HostActionRegistry;
  workspacePath?: string;
  hostProfile?: string;
  environmentFingerprint?: string;
  hostBaseline?: HostBaselineReport;
  workspaceGeneration?: () => number | Promise<number>;
  testEvidence?: TestEvidenceService;
  codeIntelligence?: CodeIntelligencePort;
  workspaceInteractionProvider?: WorkspaceInteractionProvider;
  workspaceObservationRecorder?: (
    observation: WorkspaceApplicationObservation
  ) => Promise<void> | void;
  actionBindingForInvocation?: (
    invocation: ToolInvocation,
    descriptor: HostActionDescriptor
  ) => Promise<ActionWorkspaceBinding> | ActionWorkspaceBinding;
}

export interface WorkspaceCapabilityComposition {
  profile: WorkspaceToolProfile;
  tools: ToolDefinition[];
  baseTools: ToolDefinition[];
  actionTools: ToolDefinition[];
  applicationActions: ToolDefinition[];
  codeIntelligenceTools: ToolDefinition[];
  resourceTools: ToolDefinition[];
  capabilityGraph: CapabilityGraph;
  composition: ReturnType<ToolPackComposer['compose']>;
  codeIntelligenceCapabilities: Awaited<
    ReturnType<CodeIntelligencePort['capabilities']>
  >;
}

export async function createWorkspaceCapabilityComposition(
  options: WorkspaceCapabilityCompositionOptions
): Promise<WorkspaceCapabilityComposition> {
  const includeVirtualShell = options.profile === 'legacy';
  const baseTools = createVirtualWorkspaceTools(options.workspace, {
    includeVirtualShell,
  });
  const codeIntelligence =
    options.codeIntelligence ?? new TextCodeIntelligence(options.workspace.fs);
  const codeIntelligenceCapabilities =
    await codeIntelligence.capabilities();
  const codeIntelligenceTools =
    createCodeIntelligenceTools(codeIntelligence);
  const resourceTools = options.workspaceInteractionProvider
    ? (
        await createWorkspaceResourceTools({
          workspace: options.workspace,
          provider: options.workspaceInteractionProvider,
          ...(options.workspaceObservationRecorder
            ? {
                recordObservation:
                  options.workspaceObservationRecorder,
              }
            : {}),
        })
      ).tools
    : [];
  const actionTools =
    options.actionRegistry &&
    (await options.actionRegistry.list()).length > 0
      ? await createHostActionTools(options.actionRegistry, {
          ...(options.workspace.workspaceId
            ? { workspaceId: options.workspace.workspaceId }
            : {}),
          ...(options.workspacePath
            ? { workspacePath: options.workspacePath }
            : {}),
          ...(options.environmentFingerprint
            ? { environmentFingerprint: options.environmentFingerprint }
            : {}),
          ...(options.workspaceGeneration
            ? { workspaceGeneration: options.workspaceGeneration }
            : {}),
          ...(options.testEvidence
            ? { testEvidence: options.testEvidence }
            : {}),
          ...(options.actionBindingForInvocation
            ? {
                bindingForInvocation:
                  options.actionBindingForInvocation,
              }
            : {}),
        })
      : [];
  const applicationActions = actionTools.filter((tool) =>
    tool.name.startsWith('action_')
  );
  const graph = new CapabilityGraph();
  graph.setEnvironmentFingerprint(
    options.environmentFingerprint ??
      `${options.hostProfile ?? 'portable'}-${options.profile}`
  );
  graph.register({
    id: 'filesystem',
    version: '1',
    state: options.hostBaseline?.tierState.workspace ?? 'available',
    limitations:
      options.hostBaseline?.tierState.workspace === 'unavailable'
        ? ['Workspace baseline is unavailable']
        : [],
  });
  graph.register({
    id: 'code-intelligence',
    version: '1',
    state:
      codeIntelligenceCapabilities.provider === 'text'
        ? 'degraded'
        : 'available',
    limitations: [...codeIntelligenceCapabilities.limitations],
  });
  graph.register({
    id: 'git',
    version: '1',
    state: options.hostBaseline?.tierState['portable-coding'] ?? 'available',
    limitations:
      options.hostBaseline?.tierState['portable-coding'] === 'unavailable'
        ? ['Portable coding baseline is unavailable']
        : ['portable-common-subset'],
  });
  graph.register({
    id: 'actions',
    version: '1',
    state:
      applicationActions.length > 0
        ? options.hostBaseline?.tierState['real-execution'] ?? 'available'
        : 'unavailable',
    limitations:
      applicationActions.length > 0
        ? []
        : ['No application action provider is configured'],
  });
  if (includeVirtualShell) {
    graph.register({
      id: 'virtual-shell',
      version: '1',
      state: 'available',
      limitations: ['restricted-builtins'],
    });
  }

  const composer = new ToolPackComposer();
  composer.register({
    id: 'workspace-coding',
    requiredCapabilities: ['filesystem', 'git'],
    tools: baseTools,
  });
  composer.register({
    id: 'code-intelligence',
    requiredCapabilities: ['filesystem'],
    optionalCapabilities: ['code-intelligence'],
    tools: codeIntelligenceTools,
  });
  if (resourceTools.length > 0) {
    composer.register({
      id: 'workspace-resources',
      requiredCapabilities: ['filesystem'],
      tools: resourceTools,
    });
  }
  if (applicationActions.length > 0) {
    composer.register({
      id: 'application-actions',
      requiredCapabilities: ['actions'],
      tools: actionTools,
    });
  }
  const composition = composer.compose(graph);
  return {
    profile: options.profile,
    tools: composition.tools,
    baseTools,
    actionTools: composition.tools.filter(
      (tool) =>
        tool.name.startsWith('action_') || tool.name === 'list_host_actions'
    ),
    applicationActions,
    codeIntelligenceTools,
    resourceTools,
    capabilityGraph: graph,
    composition,
    codeIntelligenceCapabilities,
  };
}

export function createWorkspaceCompletionGuard(
  profile: WorkspaceToolProfile,
  actionTools: readonly ToolDefinition[]
): CompletionGuard {
  return ({ view }) => {
    const state = evaluateCompletion(view, profile, actionTools.length > 0);
    return state.ok ? { ok: true } : { ok: false, reason: state.reason };
  };
}

export function evaluateCompletion(
  view: Pick<SessionView, 'rows'>,
  profile: WorkspaceToolProfile,
  actionAvailable: boolean
): { ok: true } | { ok: false; reason: string } {
  let lastWrite = -1;
  let lastVerification = -1;
  view.rows.forEach((row, index) => {
    if (
      row.kind === 'tool' &&
      row.status === 'completed' &&
      completionWriteTools.has(row.toolName ?? '')
    ) {
      lastWrite = index;
    }
    if (
      row.kind === 'tool' &&
      row.status === 'completed' &&
      (row.toolName?.startsWith('action_') ||
        (profile === 'legacy' &&
          (row.toolName === 'exec' || row.toolName === 'job_read')))
    ) {
      lastVerification = index;
    }
  });
  if (lastWrite < 0) return { ok: true };
  if (lastVerification > lastWrite) return { ok: true };
  if (profile === 'portable' && !actionAvailable) {
    return {
      ok: false,
      reason:
        'Files changed, but no application verification Action is available',
    };
  }
  return {
    ok: false,
    reason:
      profile === 'legacy'
        ? 'Files changed, but no newer successful exec/job_read or application Action was observed'
        : 'Files changed, but no newer successful application Action was observed',
  };
}

const completionWriteTools = new Set([
  'write_file',
  'replace_in_file',
  'append_file',
  'apply_patch',
  'apply_unified_diff',
  'delete_file',
  'git_add',
  'git_commit',
  'git_checkout',
  'git_branch',
]);
