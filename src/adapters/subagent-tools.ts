import type {
  ChildTaskSpec,
  PermissionPolicy,
  TaskBudget,
} from '../core/agent-profile';
import { AgentError } from '../core/errors';
import type { SubagentCoordinator } from '../core/subagent-coordinator';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';

type ObjectInput = Record<string, JsonValue>;

export interface SubagentToolOptions {
  coordinator: SubagentCoordinator;
  parent(invocation: ToolInvocation): {
    taskId: string;
    depth: number;
    maxDepth: number;
    permissions: PermissionPolicy;
  };
}

export function createSubagentTools(options: SubagentToolOptions): ToolDefinition[] {
  return [
    tool(
      'spawn_agent',
      'Create a child agent from any registered profile and a structured ChildTaskSpec.',
      schema({
        profile: { type: 'string' },
        brief: { type: 'string' },
        acceptance: { type: 'array', items: { type: 'string' } },
        contextRefs: { type: 'array', items: { type: 'string' } },
        contextMode: { type: 'string', enum: ['fresh', 'fork', 'artifacts'] },
        executionMode: {
          type: 'string',
          enum: ['foreground', 'background', 'isolated-worktree', 'sandbox'],
        },
        budget: { type: 'object' },
        resultSchema: { type: 'string' },
      }, ['profile', 'brief']),
      async (input, invocation) => {
        const parent = options.parent(invocation);
        const spec: ChildTaskSpec = {
          parentTaskId: parent.taskId,
          parentSessionId: invocation.sessionId,
          profile: requiredString(input, 'profile'),
          brief: requiredString(input, 'brief'),
          ...(Array.isArray(input.acceptance)
            ? { acceptance: input.acceptance.map(String) }
            : {}),
          ...(Array.isArray(input.contextRefs)
            ? { contextRefs: input.contextRefs.map(String) }
            : {}),
          budget: budgetFrom(input.budget),
          contextMode:
            stringChoice(input, 'contextMode', ['fresh', 'fork', 'artifacts']) ?? 'fresh',
          executionMode:
            stringChoice(input, 'executionMode', [
              'foreground',
              'background',
              'isolated-worktree',
              'sandbox',
            ]) ?? 'foreground',
          ...(optionalString(input, 'resultSchema')
            ? { resultSchema: optionalString(input, 'resultSchema')! }
            : {}),
        };
        return (await options.coordinator.spawn(spec, parent)) as unknown as JsonValue;
      }
    ),
    tool(
      'send_message',
      'Send a guided or queued message to a child agent, or resume a terminal child.',
      schema({
        childTaskId: { type: 'string' },
        message: { type: 'string' },
        delivery: { type: 'string', enum: ['guide', 'queue'] },
      }, ['childTaskId', 'message']),
      async (input) => {
        await options.coordinator.send(
          requiredString(input, 'childTaskId'),
          requiredString(input, 'message'),
          stringChoice(input, 'delivery', ['guide', 'queue']) ?? 'queue'
        );
        return { sent: true };
      }
    ),
    tool(
      'wait_agent',
      'Wait for a child agent and return its structured result.',
      schema({ childTaskId: { type: 'string' } }, ['childTaskId']),
      async (input) =>
        (await options.coordinator.wait(
          requiredString(input, 'childTaskId')
        )) as unknown as JsonValue
    ),
    tool(
      'stop_agent',
      'Stop a child agent and all descendants it owns.',
      schema({ childTaskId: { type: 'string' } }, ['childTaskId']),
      async (input) => {
        await options.coordinator.stop(requiredString(input, 'childTaskId'));
        return { stopped: true };
      }
    ),
    tool(
      'list_agents',
      'List child agents, optionally scoped to a parent task.',
      schema({ parentTaskId: { type: 'string' } }),
      async (input) =>
        options.coordinator.list(optionalString(input, 'parentTaskId')) as unknown as JsonValue
    ),
    tool(
      'preview_merge',
      'Preview a child workspace patch and any conflicts without changing the parent.',
      schema({ childTaskId: { type: 'string' } }, ['childTaskId']),
      async (input) =>
        options.coordinator.previewMerge(
          requiredString(input, 'childTaskId')
        ) as unknown as JsonValue
    ),
    tool(
      'apply_merge',
      'Apply a reviewed, conflict-free child workspace patch to the parent.',
      schema({ childTaskId: { type: 'string' } }, ['childTaskId']),
      async (input) =>
        options.coordinator.applyMerge(
          requiredString(input, 'childTaskId')
        ) as unknown as JsonValue
    ),
  ];
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, JsonValue>,
  execute: (input: ObjectInput, invocation: ToolInvocation) => Promise<JsonValue>
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    risk: 'write',
    effect: 'execute',
    capabilities: ['agent:spawn', 'agent:manage'],
    executionMode: 'sequential',
    replay: 'never',
    timeoutMs: 300_000,
    execute: async (input, invocation) =>
      execute(asObject(input), invocation),
  };
}

function budgetFrom(value: JsonValue | undefined): TaskBudget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const source = value as Record<string, JsonValue>;
  return {
    ...(typeof source.maxTurns === 'number' ? { maxTurns: source.maxTurns } : {}),
    ...(typeof source.maxToolCalls === 'number' ? { maxToolCalls: source.maxToolCalls } : {}),
    ...(typeof source.maxTokens === 'number' ? { maxTokens: source.maxTokens } : {}),
    ...(typeof source.deadlineMs === 'number' ? { deadlineMs: source.deadlineMs } : {}),
  };
}

function schema(
  properties: Record<string, JsonValue>,
  required: string[] = []
): Record<string, JsonValue> {
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

function asObject(value: JsonValue): ObjectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Tool input must be an object');
  }
  return value;
}

function requiredString(input: ObjectInput, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(input: ObjectInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function stringChoice<T extends string>(
  input: ObjectInput,
  key: string,
  choices: readonly T[]
): T | undefined {
  const value = input[key];
  return typeof value === 'string' && choices.includes(value as T) ? (value as T) : undefined;
}
