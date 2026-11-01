import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import { AgentError } from '../core/errors';
import {
  HostActionRegistry,
  toolNameForAction,
  type AvailableHostAction,
  type HostActionContext,
  type HostActionResult,
} from '../platform/host-action';

export async function createHostActionTools(
  registry: HostActionRegistry,
  options: {
    workspacePath?: string;
    workspaceId?: string;
    workspaceGeneration?: number | (() => number | Promise<number>);
    environmentFingerprint?: string;
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
      actionTool(registry, action, options)
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
  }
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
    approvalContext: async () => ({
      actionId: descriptor.id,
      actionVersion: descriptor.version,
      effects: [...descriptor.effects],
      risk: descriptor.risk,
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.workspaceGeneration === undefined
        ? {}
        : {
            workspaceGeneration: await resolveWorkspaceGeneration(
              options.workspaceGeneration
            ),
          }),
      ...(options.environmentFingerprint
        ? { environmentFingerprint: options.environmentFingerprint }
        : {}),
    }),
    execute: async (input, invocation) => {
      const result = await runAction(
        registry,
        action,
        options,
        input,
        invocation
      );
      assertActionSuccess(result, descriptor.id);
      return result.value;
    },
    executeDetailed: async (input, invocation) => {
      const result = await runAction(
        registry,
        action,
        options,
        input,
        invocation
      );
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
          ...(result.artifactIds?.length
            ? { artifactIds: [...result.artifactIds] }
            : {}),
        },
        ...(result.artifacts?.length
          ? {
              attachments: result.artifacts.map((artifact) => ({
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
  options: {
    workspacePath?: string;
    workspaceId?: string;
    workspaceGeneration?: number | (() => number | Promise<number>);
    environmentFingerprint?: string;
  },
  input: JsonValue,
  invocation: ToolInvocation
): Promise<HostActionResult> {
  const descriptor = action.descriptor;
  const workspaceGeneration =
    options.workspaceGeneration === undefined
      ? undefined
      : await resolveWorkspaceGeneration(options.workspaceGeneration);
  const context: HostActionContext = {
    sessionId: invocation.sessionId,
    taskId: invocation.taskId,
    requestId: invocation.call.id,
    idempotencyKey: stableDigest(
      JSON.stringify({
        actionId: descriptor.id,
        version: descriptor.version,
        input,
        workspaceId: options.workspaceId,
        workspaceGeneration,
        environmentFingerprint: options.environmentFingerprint,
      })
    ),
    ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
    ...(workspaceGeneration === undefined
      ? {}
      : { workspaceGeneration }),
    ...(options.workspacePath
      ? { workspacePath: options.workspacePath }
      : {}),
    ...(options.environmentFingerprint
      ? { environmentFingerprint: options.environmentFingerprint }
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

