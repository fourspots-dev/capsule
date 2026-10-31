import type { JsonValue, ToolDefinition } from '../core/types';
import {
  HostActionRegistry,
  toolNameForAction,
  type AvailableHostAction,
} from '../platform/host-action';

export async function createHostActionTools(
  registry: HostActionRegistry,
  options: {
    workspacePath?: string;
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
      actionTool(registry, action, options.workspacePath)
    ),
  ];
}

function actionTool(
  registry: HostActionRegistry,
  action: AvailableHostAction,
  workspacePath?: string
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
    execute: async (input, invocation) => {
      const result = await registry.invoke(
        descriptor.id,
        input,
        {
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
          ...(workspacePath ? { workspacePath } : {}),
          signal: invocation.signal,
        }
      );
      return result.value;
    },
  };
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

