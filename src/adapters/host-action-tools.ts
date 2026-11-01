import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import { AgentError } from '../core/errors';
import type { TestEvidenceService } from '../evidence';
import type { VirtualFileSystem } from '../virtual';
import {
  HostActionRegistry,
  toolNameForAction,
  type AvailableHostAction,
  type HostActionContext,
  type HostActionResult,
} from '../platform/host-action';

export interface ActionWorkspaceBinding {
  workspacePath?: string;
  workspaceId?: string;
  workspaceGeneration?: number;
  environmentFingerprint?: string;
  evidenceVfs?: VirtualFileSystem;
}

export function assertActionWorkspaceBinding(
  isChildWorkspace: boolean,
  descriptor: AvailableHostAction['descriptor']
): void {
  if (isChildWorkspace && descriptor.workspaceBinding !== 'fork') {
    throw new AgentError(
      'ACTION_WORKSPACE_BINDING_DENIED',
      `Action ${descriptor.id} is not fork-bound and cannot run in a child workspace`
    );
  }
}

export async function createHostActionTools(
  registry: HostActionRegistry,
  options: {
    workspacePath?: string;
    workspaceId?: string;
    workspaceGeneration?: number | (() => number | Promise<number>);
    environmentFingerprint?: string;
    testEvidence?: TestEvidenceService;
    bindingForInvocation?: (
      invocation: ToolInvocation,
      descriptor: AvailableHostAction['descriptor']
    ) => Promise<ActionWorkspaceBinding> | ActionWorkspaceBinding;
    signal?: AbortSignal;
  } = {}
): Promise<ToolDefinition[]> {
  const actions = (await registry.discover(options.signal)).available;
  const discovery: ToolDefinition = {
    name: 'list_host_actions',
    description:
      'List application-provided actions currently available from the host. Actions are named capabilities, not a generic shell.',
    parameters: {
      type: 'object',
      properties: {},
    },
    outputSchema: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'object' } },
      },
    },
    risk: 'read',
    effect: 'read',
    capabilities: ['action:discover'],
    executionMode: 'parallel',
    replay: 'safe',
    execute: async () =>
      ({
        actions: actions.map(describeAction),
      }) as unknown as JsonValue,
  };
  return [
    discovery,
    ...actions.map((action) =>
      actionTool(registry, action, options, new Map())
    ),
  ];
}

function actionTool(
  registry: HostActionRegistry,
  action: AvailableHostAction,
  options: {
    workspacePath?: string;
    workspaceId?: string;
    workspaceGeneration?: number | (() => number | Promise<number>);
    environmentFingerprint?: string;
    testEvidence?: TestEvidenceService;
    bindingForInvocation?: (
      invocation: ToolInvocation,
      descriptor: AvailableHostAction['descriptor']
    ) => Promise<ActionWorkspaceBinding> | ActionWorkspaceBinding;
  },
  approvalBindings: Map<string, ActionWorkspaceBinding>
): ToolDefinition {
  const descriptor = action.descriptor;
  const toolName = toolNameForAction(descriptor.id);
  return {
    name: toolName,
    description: `${descriptor.title}\n${descriptor.description}`,
    parameters: descriptor.inputSchema as Record<string, JsonValue>,
    ...(descriptor.outputSchema
      ? {
          outputSchema: descriptor.outputSchema as Record<string, JsonValue>,
        }
      : {}),
    risk: descriptor.risk,
    effect: effectFor(descriptor.effects),
    capabilities: [
      'action:invoke',
      `action:${descriptor.id}`,
      ...descriptor.effects.map((effect) => `action-effect:${effect}`),
    ],
    executionMode:
      descriptor.effects.every((effect) => effect === 'read')
        ? 'parallel'
        : 'sequential',
    replay: descriptor.effects.every((effect) => effect === 'read')
      ? 'safe'
      : 'never',
    ...(descriptor.timeoutMs === undefined
      ? {}
      : { timeoutMs: descriptor.timeoutMs }),
    approvalContext: async (_input, invocation) => {
      const binding = await resolveBinding(options, invocation, descriptor);
      approvalBindings.set(invocation.call.id, binding);
      return {
        actionId: descriptor.id,
        actionVersion: descriptor.version,
        effects: [...descriptor.effects],
        risk: descriptor.risk,
        ...bindingContext(binding),
      };
    },
    execute: async (input, invocation) => {
      const binding = await resolveBinding(options, invocation, descriptor);
      const result = await runAction(
        registry,
        action,
        binding,
        input,
        invocation
      );
      assertActionSuccess(result, descriptor.id);
      return result.value;
    },
    executeDetailed: async (input, invocation) => {
      const approved = approvalBindings.get(invocation.call.id);
      const current = await resolveBinding(options, invocation, descriptor);
      if (
        approved &&
        descriptor.risk !== 'read' &&
        bindingDigest(approved) !== bindingDigest(current)
      ) {
        approvalBindings.delete(invocation.call.id);
        throw new AgentError(
          'ACTION_APPROVAL_STALE',
          `Workspace or environment changed after approval: ${descriptor.id}`
        );
      }
      approvalBindings.delete(invocation.call.id);
      const executionBinding = approved ?? current;
      const result = await runAction(
        registry,
        action,
        executionBinding,
        input,
        invocation
      );
      const evidence =
        descriptor.test && options.testEvidence
          ? await options.testEvidence.recordActionTest({
              sessionId: invocation.sessionId,
              taskId: invocation.taskId,
              action: {
                id: descriptor.id,
                version: descriptor.version,
              },
              runner: descriptor.test.runner,
              result,
              ...(executionBinding.workspaceGeneration === undefined
                ? {}
                : {
                    workspaceGeneration:
                      executionBinding.workspaceGeneration,
                  }),
              ...(executionBinding.evidenceVfs
                ? { vfs: executionBinding.evidenceVfs }
                : {}),
              ...(executionBinding.environmentFingerprint
                ? {
                    environmentFingerprint:
                      executionBinding.environmentFingerprint,
                  }
                : {}),
            })
          : undefined;
      const attachmentArtifacts = evidence
        ? []
        : result.artifacts ?? [];
      const artifactIds = evidence
        ? evidence.artifactIds
        : result.artifactIds ?? [];
      return {
        value: result.value,
        metadata: {
          status: result.status,
          action: {
            id: descriptor.id,
            version: descriptor.version,
            sourceId: action.sourceId,
          },
          ...(result.durationMs === undefined
            ? {}
            : { durationMs: result.durationMs }),
          ...(result.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
          ...(result.truncated === undefined
            ? {}
            : { truncated: result.truncated }),
          ...(result.replayed === undefined
            ? {}
            : { replayed: result.replayed }),
          ...(artifactIds.length
            ? { artifactIds: [...artifactIds] }
            : {}),
          ...(evidence
            ? {
                evidence: {
                  id: evidence.id,
                  status: evidence.status,
                },
              }
            : {}),
        },
        ...(attachmentArtifacts.length
          ? {
              attachments: attachmentArtifacts.map((artifact) => ({
                name: artifact.name,
                mimeType: artifact.mimeType,
                kind: artifact.kind,
                data: artifact.data,
              })),
            }
          : {}),
      };
    },
  };
}

async function runAction(
  registry: HostActionRegistry,
  action: AvailableHostAction,
  binding: ActionWorkspaceBinding,
  input: JsonValue,
  invocation: ToolInvocation
): Promise<HostActionResult> {
  const descriptor = action.descriptor;
  const context: HostActionContext = {
    sessionId: invocation.sessionId,
    taskId: invocation.taskId,
    requestId: invocation.call.id,
    idempotencyKey: stableDigest(
      JSON.stringify({
        actionId: descriptor.id,
        version: descriptor.version,
        input,
        workspaceId: binding.workspaceId,
        workspaceGeneration: binding.workspaceGeneration,
        environmentFingerprint: binding.environmentFingerprint,
      })
    ),
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
    ...(binding.workspaceGeneration === undefined
      ? {}
      : { workspaceGeneration: binding.workspaceGeneration }),
    ...(binding.workspacePath
      ? { workspacePath: binding.workspacePath }
      : {}),
    ...(binding.environmentFingerprint
      ? { environmentFingerprint: binding.environmentFingerprint }
      : {}),
    signal: invocation.signal,
  };
  const result = await registry.invoke(descriptor.id, input, context);
  return result;
}

function assertActionSuccess(
  result: HostActionResult,
  actionId: string
): void {
  if (result.status === 'failed') {
    throw new AgentError(
      'ACTION_FAILED',
      `Application Action failed: ${actionId}`,
      {
        details: {
          actionId,
          result: result.value,
          ...(result.exitCode === undefined
            ? {}
            : { exitCode: result.exitCode }),
        },
      }
    );
  }
  if (result.status === 'cancelled') {
    throw new AgentError(
      'ACTION_CANCELLED',
      `Application Action was cancelled: ${actionId}`
    );
  }
}

async function resolveWorkspaceGeneration(
  value: number | (() => number | Promise<number>)
): Promise<number> {
  return typeof value === 'function' ? value() : value;
}

async function resolveBinding(
  options: {
    workspacePath?: string;
    workspaceId?: string;
    workspaceGeneration?: number | (() => number | Promise<number>);
    environmentFingerprint?: string;
    bindingForInvocation?: (
      invocation: ToolInvocation,
      descriptor: AvailableHostAction['descriptor']
    ) => Promise<ActionWorkspaceBinding> | ActionWorkspaceBinding;
  },
  invocation: ToolInvocation,
  descriptor: AvailableHostAction['descriptor']
): Promise<ActionWorkspaceBinding> {
  const dynamic = await options.bindingForInvocation?.(invocation, descriptor);
  const workspaceGeneration =
    dynamic?.workspaceGeneration ??
    (options.workspaceGeneration === undefined
      ? undefined
      : await resolveWorkspaceGeneration(options.workspaceGeneration));
  return {
    ...(dynamic?.workspacePath ?? options.workspacePath
      ? {
          workspacePath:
            dynamic?.workspacePath ?? options.workspacePath,
        }
      : {}),
    ...(dynamic?.workspaceId ?? options.workspaceId
      ? { workspaceId: dynamic?.workspaceId ?? options.workspaceId }
      : {}),
    ...(workspaceGeneration === undefined ? {} : { workspaceGeneration }),
    ...(dynamic?.environmentFingerprint ?? options.environmentFingerprint
      ? {
          environmentFingerprint:
            dynamic?.environmentFingerprint ??
            options.environmentFingerprint,
        }
      : {}),
    ...(dynamic?.evidenceVfs ? { evidenceVfs: dynamic.evidenceVfs } : {}),
  };
}

function bindingDigest(binding: ActionWorkspaceBinding): string {
  return stableDigest(JSON.stringify(binding));
}

function bindingContext(
  binding: ActionWorkspaceBinding
): Record<string, JsonValue> {
  return {
    ...(binding.workspacePath
      ? { workspacePath: binding.workspacePath }
      : {}),
    ...(binding.workspaceId ? { workspaceId: binding.workspaceId } : {}),
    ...(binding.workspaceGeneration === undefined
      ? {}
      : { workspaceGeneration: binding.workspaceGeneration }),
    ...(binding.environmentFingerprint
      ? { environmentFingerprint: binding.environmentFingerprint }
      : {}),
  };
}

function stableDigest(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
}

function describeAction(action: AvailableHostAction): JsonValue {
  return {
    id: action.descriptor.id,
    version: action.descriptor.version,
    title: action.descriptor.title,
    description: action.descriptor.description,
    effects: [...action.descriptor.effects],
    risk: action.descriptor.risk,
    state: action.probe.state,
    ...(action.descriptor.limitations
      ? { limitations: [...action.descriptor.limitations] }
      : {}),
  };
}

function effectFor(
  effects: readonly ('read' | 'write' | 'execute' | 'network')[]
): NonNullable<ToolDefinition['effect']> {
  if (effects.includes('network')) return 'network';
  if (effects.includes('execute')) return 'execute';
  if (effects.includes('write')) return 'write';
  return 'read';
}

