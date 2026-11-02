import type { ArtifactStore } from '../core/artifact-store';
import type { EvidenceStore } from '../core/evidence-store';
import type { ToolDefinition, ToolInvocation } from '../core/types';
import {
  createTestEvidenceCompletionGuard,
  TestEvidenceService,
} from '../evidence';
import type { HostActionRegistry } from '../platform/host-action';
import type { HostBaselineReport } from '../host';
import type { CodeIntelligencePort } from '../platform/code-intelligence';
import type { WorkspaceInteractionProvider } from '../platform/workspace-interaction';
import type { VirtualWorkspace } from '../virtual';
import {
  createWorkspaceCapabilityComposition,
  type WorkspaceCapabilityComposition,
} from './workspace-capability-composition';
import type { ChromeWorkspaceScopeRegistry } from './chrome-workspace-scope';
import type { ChromeWorkspaceObservationStore } from '../adapters/chrome-workspace-observation-store';
import {
  workspacePath,
  workspaceResourceUri,
} from '../platform/workspace-resource';

export class ChromeScopedWorkspaceManager {
  private readonly compositions = new Map<
    string,
    Promise<WorkspaceCapabilityComposition>
  >();
  private readonly evidence = new Map<string, TestEvidenceService>();
  private readonly sessionWorkspace = new Map<string, string>();

  constructor(
    private readonly options: {
      workspaces: ChromeWorkspaceScopeRegistry;
      workspaceIdForSession: (sessionId: string) => Promise<string | undefined>;
      actions: HostActionRegistry;
      baseline: HostBaselineReport;
      environmentFingerprint: string;
      artifacts: ArtifactStore;
      evidenceStore: EvidenceStore;
      interaction: WorkspaceInteractionProvider;
      observations: ChromeWorkspaceObservationStore;
      codeIntelligence?: (
        workspace: VirtualWorkspace
      ) => CodeIntelligencePort | undefined;
    }
  ) {}

  bindSession(sessionId: string, workspaceId: string): void {
    this.sessionWorkspace.set(sessionId, workspaceId);
  }

  async workspaceForSession(sessionId: string): Promise<VirtualWorkspace> {
    const workspaceId = await this.resolveWorkspaceId(sessionId);
    return this.options.workspaces.get(workspaceId);
  }

  async compositionForSession(
    sessionId: string
  ): Promise<WorkspaceCapabilityComposition> {
    return this.composition(await this.resolveWorkspaceId(sessionId));
  }

  wrapTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
    return tools.map((definition) => ({
      ...definition,
      execute: async (input, invocation) => {
        const result = await (
          await this.toolForInvocation(invocation, definition.name)
        ).execute(
          input,
          invocation
        );
        return this.decorateToolOutput(
          definition.name,
          result,
          invocation
        );
      },
      ...(definition.executeDetailed
        ? {
            executeDetailed: async (
              input: import('../core/types').JsonValue,
              invocation: ToolInvocation
            ) =>
              (
                await this.toolForInvocation(
                  invocation,
                  definition.name
                )
              ).executeDetailed!(input, invocation),
          }
        : {}),
    }));
  }

  async completionGuard(context: Parameters<
    ReturnType<typeof createTestEvidenceCompletionGuard>
  >[0]) {
    const workspaceId = await this.resolveWorkspaceId(context.sessionId);
    const lastWrite = latestWrite(context.view.rows);
    if (lastWrite !== undefined) {
      const observations = await this.options.observations.list({
        sessionId: context.sessionId,
        taskId: context.taskId,
      });
      const workspace = await this.options.workspaces.get(workspaceId);
      const generation = await workspace.generation();
      const valid = currentWorkspaceObservation(
        observations,
        generation,
        lastWrite.completedAt
      );
      if (valid) return { ok: true };
    }
    const service = await this.evidenceFor(workspaceId);
    return createTestEvidenceCompletionGuard({
      service,
      store: this.options.evidenceStore,
      actionVersions: async (actionId) =>
        (await this.options.actions.list()).find(
          (action) => action.descriptor.id === actionId
        )?.descriptor.version,
    })(context);
  }

  async dispose(): Promise<void> {
    this.compositions.clear();
    this.evidence.clear();
    this.sessionWorkspace.clear();
  }

  private async composition(
    workspaceId: string
  ): Promise<WorkspaceCapabilityComposition> {
    let composition = this.compositions.get(workspaceId);
    if (!composition) {
      composition = this.createComposition(workspaceId);
      this.compositions.set(workspaceId, composition);
    }
    return composition;
  }

  private async createComposition(
    workspaceId: string
  ): Promise<WorkspaceCapabilityComposition> {
    const workspace = await this.options.workspaces.get(workspaceId);
    const evidence = await this.evidenceFor(workspaceId);
    return createWorkspaceCapabilityComposition({
      workspace,
      profile: 'portable',
      actionRegistry: this.options.actions,
      workspacePath: '',
      hostProfile: 'browser-agent',
      environmentFingerprint: this.options.environmentFingerprint,
      hostBaseline: this.options.baseline,
      workspaceGeneration: () => workspace.generation(),
      testEvidence: evidence,
      workspaceInteractionProvider: this.options.interaction,
      workspaceObservationRecorder: (observation) =>
        this.options.observations.save(observation),
      ...(this.options.codeIntelligence
        ? {
            codeIntelligence:
              this.options.codeIntelligence(workspace) ??
              undefined,
          }
        : {}),
      actionBindingForInvocation: async () => ({
        workspaceId: workspace.workspaceId,
        workspaceGeneration: await workspace.generation(),
        environmentFingerprint: this.options.environmentFingerprint,
        evidenceVfs: workspace.fs,
      }),
    });
  }

  private async evidenceFor(
    workspaceId: string
  ): Promise<TestEvidenceService> {
    const existing = this.evidence.get(workspaceId);
    if (existing) return existing;
    const workspace = await this.options.workspaces.get(workspaceId);
    const service = new TestEvidenceService({
      store: this.options.evidenceStore,
      artifacts: this.options.artifacts,
      vfs: workspace.fs,
      environmentFingerprint: this.options.environmentFingerprint,
      workspaceGeneration: () => workspace.generation(),
    });
    this.evidence.set(workspaceId, service);
    return service;
  }

  private async toolForInvocation(
    invocation: ToolInvocation,
    name: string
  ): Promise<ToolDefinition> {
    const composition = await this.compositionForSession(invocation.sessionId);
    const tool = composition.tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Scoped workspace tool is unavailable: ${name}`);
    }
    return tool;
  }

  private async decorateToolOutput(
    name: string,
    value: import('../core/types').JsonValue,
    invocation: ToolInvocation
  ): Promise<import('../core/types').JsonValue> {
    if (
      !resourceFileTools.has(name) ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      typeof value.path !== 'string'
    ) {
      return value;
    }
    const workspace = await this.workspaceForSession(invocation.sessionId);
    const path = workspacePath(value.path);
    return {
      ...value,
      workspaceId: workspace.workspaceId,
      generation: await workspace.generation(),
      resourceUri: workspaceResourceUri(workspace.workspaceId, path),
      openable: true,
      exportable: true,
    };
  }

  private async resolveWorkspaceId(sessionId: string): Promise<string> {
    const workspaceId =
      this.sessionWorkspace.get(sessionId) ??
      (await this.options.workspaceIdForSession(sessionId));
    if (!workspaceId) {
      throw new Error(
        `No workspace scope is bound to session ${sessionId}`
      );
    }
    return workspaceId;
  }
}

function latestWrite(
  rows: ReadonlyArray<{
    kind: string;
    status: string;
    toolName?: string;
    completedAt?: number;
  }>
): { completedAt?: number } | undefined {
  return [...rows]
    .reverse()
    .find(
      (row) =>
        row.kind === 'tool' &&
        row.status === 'completed' &&
        completionWriteTools.has(row.toolName ?? '')
    );
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

const resourceFileTools = new Set([
  'read_file',
  'write_file',
  'replace_in_file',
  'append_file',
  'apply_patch',
  'apply_unified_diff',
]);

export function currentWorkspaceObservation(
  observations: readonly import('../platform/workspace-interaction').WorkspaceApplicationObservation[],
  generation: number,
  lastWriteAt?: number
) {
  return observations
    .filter(
      (observation) =>
        observation.workspaceGeneration === generation &&
        observation.createdAt >= (lastWriteAt ?? 0)
    )
    .reverse()
    .find(
      (observation) =>
        observation.loaded &&
        observation.consoleErrors.length === 0 &&
        observation.assertions.length > 0 &&
        observation.assertions.every((assertion) => assertion.passed)
    );
}
