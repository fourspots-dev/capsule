import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import type { VirtualWorkspace } from '../virtual';
import { applyUnifiedPatch } from '../virtual/patch';
import { globVirtualFiles, searchVirtualFiles } from '../virtual/search';

type ObjectInput = Record<string, JsonValue>;

export function createVirtualWorkspaceTools(
  workspace: VirtualWorkspace
): ToolDefinition[] {
  return [
    tool(
      'read_file',
      'Read a UTF-8 or base64 file from the virtual workspace.',
      schema(
        {
          path: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
          offset: { type: 'integer' },
          length: { type: 'integer' },
        },
        ['path']
      ),
      'read',
      'read',
      async (input, invocation) => {
        const path = requiredString(input, 'path');
        const data = await workspace.fs.read(path, {
          signal: invocation.signal,
          ...(optionalNumber(input, 'offset') === undefined
            ? {}
            : { offset: optionalNumber(input, 'offset') }),
          ...(optionalNumber(input, 'length') === undefined
            ? {}
            : { length: optionalNumber(input, 'length') }),
        });
        return {
          path,
          bytes: data.byteLength,
          ...(input.encoding === 'base64'
            ? { dataBase64: bytesToBase64(data) }
            : { text: new TextDecoder().decode(data) }),
        };
      }
    ),
    tool(
      'write_file',
      'Atomically write a UTF-8 or base64 file in the virtual workspace.',
      schema(
        {
          path: { type: 'string' },
          text: { type: 'string' },
          dataBase64: { type: 'string' },
          expected_version: { type: 'integer' },
          mode: { type: 'integer' },
        },
        ['path']
      ),
      'write',
      'write',
      async (input, invocation) => {
        const path = requiredString(input, 'path');
        const text = optionalString(input, 'text');
        const base64 = optionalString(input, 'dataBase64');
        if (text === undefined && base64 === undefined) {
          throw new AgentError(
            'TOOL_ARGUMENTS_INVALID',
            'write_file requires text or dataBase64'
          );
        }
        const expected = optionalNumber(input, 'expected_version');
        return workspace.fs.write(
          path,
          base64 === undefined
            ? new TextEncoder().encode(text)
            : base64ToBytes(base64),
          {
            signal: invocation.signal,
            ...(expected === undefined ? {} : { expectedVersion: expected }),
            ...(optionalNumber(input, 'mode') === undefined
              ? {}
              : { mode: optionalNumber(input, 'mode') }),
          }
        );
      }
    ),
    tool(
      'list_files',
      'List files and directories in the virtual workspace.',
      schema({
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      }),
      'read',
      'read',
      async (input, invocation) =>
        workspace.fs.list(optionalString(input, 'path') ?? '', {
          recursive: input.recursive === true,
          signal: invocation.signal,
        })
    ),
    tool(
      'delete_file',
      'Delete a file or directory tree in the virtual workspace.',
      schema({
        path: { type: 'string' },
        recursive: { type: 'boolean' },
      }, ['path']),
      'write',
      'write',
      async (input, invocation) => ({
        deleted: await workspace.fs.remove(requiredString(input, 'path'), {
          recursive: input.recursive === true,
        }),
      })
    ),
    tool(
      'search',
      'Search text in virtual files with optional regex, glob and context filters.',
      schema(
        {
          pattern: { type: 'string' },
          path: { type: 'string' },
          regex: { type: 'boolean' },
          case_sensitive: { type: 'boolean' },
          whole_word: { type: 'boolean' },
          include: { type: 'array', items: { type: 'string' } },
          exclude: { type: 'array', items: { type: 'string' } },
          context_lines: { type: 'integer' },
          max_results: { type: 'integer' },
        },
        ['pattern']
      ),
      'read',
      'read',
      async (input, invocation) =>
        searchVirtualFiles(workspace.fs, {
          pattern: requiredString(input, 'pattern'),
          signal: invocation.signal,
          caseSensitive: input.case_sensitive === true,
          regex: input.regex === true,
          wholeWord: input.whole_word === true,
          ...(optionalString(input, 'path')
            ? { path: optionalString(input, 'path')! }
            : {}),
          ...(stringArray(input.include)
            ? { include: stringArray(input.include)! }
            : {}),
          ...(stringArray(input.exclude)
            ? { exclude: stringArray(input.exclude)! }
            : {}),
          ...(optionalNumber(input, 'context_lines') === undefined
            ? {}
            : { contextLines: optionalNumber(input, 'context_lines') }),
          ...(optionalNumber(input, 'max_results') === undefined
            ? {}
            : { maxResults: optionalNumber(input, 'max_results') }),
        })
    ),
    tool(
      'glob',
      'Find virtual files using one or more glob patterns.',
      schema(
        {
          patterns: { type: 'array', items: { type: 'string' } },
          path: { type: 'string' },
          exclude: { type: 'array', items: { type: 'string' } },
        },
        ['patterns']
      ),
      'read',
      'read',
      async (input, invocation) => {
        const patterns = stringArray(input.patterns);
        if (!patterns) {
          throw new AgentError('TOOL_ARGUMENTS_INVALID', 'patterns must be an array');
        }
        return globVirtualFiles(workspace.fs, patterns, {
          signal: invocation.signal,
          ...(optionalString(input, 'path')
            ? { path: optionalString(input, 'path')! }
            : {}),
          ...(stringArray(input.exclude)
            ? { exclude: stringArray(input.exclude)! }
            : {}),
        });
      }
    ),
    tool(
      'apply_patch',
      'Validate and atomically apply a unified diff to virtual files.',
      schema(
        {
          patch: { type: 'string' },
          expected_versions: { type: 'object' },
          expected_hashes: { type: 'object' },
        },
        ['patch']
      ),
      'write',
      'write',
      async (input, invocation) =>
        applyUnifiedPatch(
          workspace.fs,
          requiredString(input, 'patch'),
          {
            signal: invocation.signal,
            ...(numberRecord(input.expected_versions)
              ? { expectedVersions: numberRecord(input.expected_versions)! }
              : {}),
            ...(stringRecord(input.expected_hashes)
              ? { expectedHashes: stringRecord(input.expected_hashes)! }
              : {}),
          }
        ) as unknown as JsonValue
    ),
    tool(
      'exec',
      'Execute the supported Virtual Shell subset without host Bash.',
      schema(
        {
          script: { type: 'string' },
          stdin: { type: 'string' },
        },
        ['script']
      ),
      'dangerous',
      'execute',
      async (input, invocation) =>
        workspace.shell.execute(requiredString(input, 'script'), {
          signal: invocation.signal,
          ...(optionalString(input, 'stdin') === undefined
            ? {}
            : { stdin: optionalString(input, 'stdin') }),
        }) as unknown as JsonValue
    ),
    tool(
      'job_start',
      'Start a cancellable background Virtual Shell job.',
      schema({
        script: { type: 'string' },
        stdin: { type: 'string' },
      }, ['script']),
      'dangerous',
      'execute',
      async (input) =>
        workspace.jobs.start(requiredString(input, 'script'), {
          ...(optionalString(input, 'stdin') === undefined
            ? {}
            : { stdin: optionalString(input, 'stdin') }),
        }) as unknown as JsonValue
    ),
    tool(
      'job_read',
      'Read a background job status and captured output.',
      schema({ job_id: { type: 'string' } }, ['job_id']),
      'read',
      'read',
      async (input) => workspace.jobs.read(requiredString(input, 'job_id')) as unknown as JsonValue
    ),
    tool(
      'job_list',
      'List background jobs newest first.',
      schema({}),
      'read',
      'read',
      async () => workspace.jobs.list() as unknown as JsonValue
    ),
    tool(
      'job_cancel',
      'Cancel a queued or running background job.',
      schema({ job_id: { type: 'string' } }, ['job_id']),
      'dangerous',
      'execute',
      async (input) => workspace.jobs.cancel(requiredString(input, 'job_id')) as unknown as JsonValue
    ),
  ];
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, JsonValue>,
  risk: ToolDefinition['risk'],
  effect: NonNullable<ToolDefinition['effect']>,
  execute: (input: ObjectInput, invocation: ToolInvocation) => Promise<unknown>
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    risk,
    effect,
    capabilities: [
      `workspace:${effect}`,
      ...(name.startsWith('job_') ? ['workspace:jobs'] : []),
    ],
    executionMode: effect === 'read' ? 'parallel' : 'sequential',
    replay: effect === 'read' ? 'safe' : 'never',
    timeoutMs: name === 'exec' ? 300_000 : 120_000,
    execute: async (input, invocation) =>
      (await execute(asObject(input), invocation)) as JsonValue,
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
  return typeof value === 'string' && value ? value : undefined;
}

function optionalNumber(input: ObjectInput, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
}

function numberRecord(value: JsonValue | undefined): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number')
  );
}

function stringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  );
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}
