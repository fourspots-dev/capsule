import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition } from '../core/types';
import type { GitBackend } from './types';

export function createGitTools(git: GitBackend): ToolDefinition[] {
  return [
    tool(
      'git_init',
      'Initialize a Git-compatible repository in the workspace root.',
      {
        initial_branch: { type: 'string' },
      },
      'write',
      'write',
      async (input) =>
        git.init({
          ...(optionalString(input, 'initial_branch')
            ? { initialBranch: optionalString(input, 'initial_branch')! }
            : {}),
        }) as unknown as JsonValue
    ),
    tool('git_status', 'Show branch, staged, unstaged, untracked and conflicted Git state.', {}, 'read', 'read', async (_input, signal) =>
      git.status(signal) as unknown as JsonValue
    ),
    tool(
      'git_add',
      'Stage one or more workspace-relative paths in Git.',
      {
        paths: {
          type: 'array',
          items: { type: 'string' },
        },
      },
      'write',
      'write',
      async (input, signal) => {
        const paths = stringArray(input.paths);
        if (!paths?.length) {
          throw new AgentError('GIT_PATH_INVALID', 'paths must be a non-empty array');
        }
        await git.add(paths, signal);
        return { staged: paths };
      },
      ['paths']
    ),
    tool(
      'git_commit',
      'Create a commit from the current Git index.',
      {
        message: { type: 'string' },
        allow_empty: { type: 'boolean' },
        author_name: { type: 'string' },
        author_email: { type: 'string' },
      },
      'dangerous',
      'write',
      async (input, signal) =>
        git.commit(
          {
            message: requiredString(input, 'message'),
            ...(input.allow_empty === true ? { allowEmpty: true } : {}),
            ...(optionalString(input, 'author_name') || optionalString(input, 'author_email')
              ? {
                  author: {
                    ...(optionalString(input, 'author_name')
                      ? { name: optionalString(input, 'author_name')! }
                      : {}),
                    ...(optionalString(input, 'author_email')
                      ? { email: optionalString(input, 'author_email')! }
                      : {}),
                  },
                }
              : {}),
          },
          signal
        ) as unknown as JsonValue,
      ['message']
    ),
    tool(
      'git_log',
      'List commits reachable from HEAD or a revision.',
      {
        max_count: { type: 'integer' },
        revision: { type: 'string' },
      },
      'read',
      'read',
      async (input, signal) =>
        git.log(
          {
            ...(numberValue(input.max_count) === undefined
              ? {}
              : { maxCount: Math.max(1, Math.min(1000, numberValue(input.max_count)!)) }),
            ...(optionalString(input, 'revision')
              ? { revision: optionalString(input, 'revision')! }
              : {}),
          },
          signal
        ) as unknown as JsonValue
    ),
    tool(
      'git_show',
      'Show a commit, tree, blob or tag by revision.',
      { revision: { type: 'string' } },
      'read',
      'read',
      async (input, signal) =>
        git.show(requiredString(input, 'revision'), signal),
      ['revision']
    ),
    tool(
      'git_diff',
      'Show changes between the working tree, index, HEAD or revisions.',
      {
        from: { type: 'string' },
        to: { type: 'string' },
        staged: { type: 'boolean' },
      },
      'read',
      'read',
      async (input, signal) =>
        git.diff(
          {
            ...(optionalString(input, 'from')
              ? { from: optionalString(input, 'from')! }
              : {}),
            ...(optionalString(input, 'to')
              ? { to: optionalString(input, 'to')! }
              : {}),
            ...(input.staged === true ? { staged: true } : {}),
          },
          signal
        ) as unknown as JsonValue
    ),
    tool(
      'git_branch',
      'List, create or delete local Git branches.',
      {
        action: { type: 'string', enum: ['list', 'create', 'delete'] },
        name: { type: 'string' },
      },
      'write',
      'write',
      async (input, signal) => {
        const action = optionalString(input, 'action') ?? 'list';
        if (action === 'list') {
          return git.branches(signal) as unknown as JsonValue;
        }
        const name = requiredString(input, 'name');
        if (action === 'create') await git.createBranch(name);
        else if (action === 'delete') await git.deleteBranch(name);
        else throw new AgentError('GIT_ARGUMENT_INVALID', `Unknown branch action: ${action}`);
        return { action, name };
      },
      ['action']
    ),
    tool(
      'git_checkout',
      'Switch the working tree to a branch or commit. Dirty tracked files block checkout.',
      { target: { type: 'string' } },
      'dangerous',
      'write',
      async (input, signal) => {
        await git.checkout(requiredString(input, 'target'), signal);
        return { checkedOut: requiredString(input, 'target') };
      },
      ['target']
    ),
    tool(
      'git_rev_parse',
      'Resolve HEAD, a branch, tag or full SHA-1 to a commit id.',
      { revision: { type: 'string' } },
      'read',
      'read',
      async (input, signal) => ({
        revision: requiredString(input, 'revision'),
        oid: await git.revParse(requiredString(input, 'revision')),
      }),
      ['revision']
    ),
  ];
}

function tool(
  name: string,
  description: string,
  properties: Record<string, JsonValue>,
  risk: ToolDefinition['risk'],
  effect: NonNullable<ToolDefinition['effect']>,
  execute: (
    input: Record<string, JsonValue>,
    signal: AbortSignal
  ) => Promise<JsonValue>,
  required: string[] = []
): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties,
      ...(required.length ? { required } : {}),
    },
    risk,
    effect,
    capabilities: ['workspace:git', 'git:portable'],
    executionMode: effect === 'read' ? 'parallel' : 'sequential',
    replay: effect === 'read' ? 'safe' : 'never',
    timeoutMs: 120_000,
    execute: async (input, invocation) => {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Git tool input must be an object');
      }
      return execute(
        input as Record<string, JsonValue>,
        invocation.signal
      );
    },
  };
}

function requiredString(input: Record<string, JsonValue>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(input: Record<string, JsonValue>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined;
}
