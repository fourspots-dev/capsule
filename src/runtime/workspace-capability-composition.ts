import { createHostActionTools } from '../adapters/host-action-tools';
import { createVirtualWorkspaceTools } from '../adapters/virtual-workspace-tools';
import type { CompletionGuard } from '../core/session-runtime';
import type { SessionView, ToolDefinition } from '../core/types';
import { CapabilityGraph } from '../platform/capability';
import type { HostActionRegistry } from '../platform/host-action';
import type { HostBaselineReport } from '../host';
import type { TestEvidenceService } from '../evidence';
import { ToolPackComposer } from '../platform/tool-pack';
import type { CodeIntelligencePort } from '../platform/code-intelligence';
import type { VirtualWorkspace } from '../virtual';
import { TextCodeIntelligence } from '../intelligence/text-index';
import { createCodeIntelligenceTools } from './code-intelligence-toolpack';

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
}

export interface WorkspaceCapabilityComposition {
  profile: WorkspaceToolProfile;
  tools: ToolDefinition[];
  baseTools: ToolDefinition[];
  actionTools: ToolDefinition[];
  applicationActions: ToolDefinition[];
  codeIntelligenceTools: ToolDefinition[];
  capabilityGraph: CapabilityGraph;
  composition: ReturnType<ToolPackComposer['compose']>;
  prompt: string;
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
    capabilityGraph: graph,
    composition,
    prompt: buildCapabilityPrompt({
      profile: options.profile,
      actions: applicationActions,
      legacyShell: includeVirtualShell,
      codeIntelligence: codeIntelligenceCapabilities,
    }),
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

function buildCapabilityPrompt(input: {
  profile: WorkspaceToolProfile;
  actions: readonly ToolDefinition[];
  legacyShell: boolean;
  codeIntelligence: Awaited<
    ReturnType<CodeIntelligencePort['capabilities']>
  >;
}): string {
  const lines = [
    'You are tinyai, a coding agent operating in a portable workspace.',
    'Use Workspace-relative paths only. Never expose or depend on a host absolute path.',
    'Workspace file, search, patch and Portable Git tools are available.',
    'Use discover_tests to identify portable test files before choosing an execution Action.',
  ];
  if (input.actions.length) {
    lines.push(
      `Application actions are available: ${input.actions
        .map((tool) => tool.name)
        .join(', ')}. Use list_host_actions for their descriptions.`
    );
  } else {
    lines.push(
      'No application actions are available. Do not invent command or test execution.'
    );
  }
  if (input.legacyShell) {
    lines.push(
      'Legacy VirtualShell is enabled with restricted file and text builtins. It is not a host Bash or binary runner.'
    );
  } else {
    lines.push(
      'There is no generic exec, Python, Node, shell or Git binary runner. Use declared application actions for execution.'
    );
  }
  lines.push(
    `Code intelligence provider: ${input.codeIntelligence.provider}. ${
      input.codeIntelligence.limitations.length
        ? input.codeIntelligence.limitations.join('; ')
        : 'Semantic capabilities are available.'
    }`
  );
  lines.push(
    'Inspect before editing. Keep changes focused and reversible.',
    'Do not claim a check passed unless a current host Action or legacy execution result was observed.',
    'Final answers must summarize changes, verification evidence and unresolved risks.'
  );
  return lines.join('\n');
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
