import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import { PortableGitBackend } from '../git/backend';
import { createGitTools } from '../git/tools';
import type { VirtualWorkspace } from '../virtual';
import { globVirtualFiles, searchVirtualFiles } from '../virtual/search';
import { createPatchTools } from './patch-tools';

type ObjectInput = Record<string, JsonValue>;

export function createVirtualWorkspaceTools(
  workspace: VirtualWorkspace
): ToolDefinition[] {
  const git = new PortableGitBackend(workspace.fs);
  return [
    tool(
      'read_file',
      'Read a UTF-8 or base64 file from the virtual workspace.',
      schema(
        {
          path: { type: 'string' },
          encoding: { type: 'string', enum: ['utf8', 'base64'] },
          offset: {
            type: 'integer',
            description: 'UTF-8 byte offset, not a line number',
          },
          length: { type: 'integer', description: 'Maximum bytes to read' },
          start_line: { type: 'integer', description: '1-based inclusive line' },
          end_line: { type: 'integer', description: '1-based inclusive line' },
        },
        ['path']
      ),
      'read',
      'read',
      async (input, invocation) => {
        const path = requiredString(input, 'path');
        let data = await workspace.fs.read(path, {
          signal: invocation.signal,
          ...(optionalNumber(input, 'offset') === undefined
            ? {}
            : { offset: optionalNumber(input, 'offset') }),
          ...(optionalNumber(input, 'length') === undefined
            ? {}
            : { length: optionalNumber(input, 'length') }),
        });
        const startLine = optionalNumber(input, 'start_line');
        const endLine = optionalNumber(input, 'end_line');
        if (startLine !== undefined || endLine !== undefined) {
          const lines = new TextDecoder().decode(data).split('\n');
          const start = Math.max(1, startLine ?? 1) - 1;
          const end =
            endLine === undefined
              ? lines.length
              : Math.max(start + 1, endLine);
          data = new TextEncoder().encode(lines.slice(start, end).join('\n'));
        }
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
      'replace_in_file',
      'Replace an exact text occurrence in a UTF-8 file. Prefer this for small reliable edits.',
      schema(
        {
          path: { type: 'string' },
          old_text: { type: 'string' },
          new_text: { type: 'string' },
          replace_all: { type: 'boolean' },
          expected_version: { type: 'integer' },
        },
        ['path', 'old_text', 'new_text']
      ),
      'write',
      'write',
      async (input, invocation) => {
        const path = requiredString(input, 'path');
        const oldText = requiredString(input, 'old_text');
        const newText = typeof input.new_text === 'string' ? input.new_text : '';
        const info = await workspace.fs.stat(path, invocation.signal);
        if (!info || info.kind !== 'file') {
          throw new AgentError('VFS_NOT_FOUND', `Virtual file not found: ${path}`);
        }
        const text = new TextDecoder().decode(
          await workspace.fs.read(path, { signal: invocation.signal })
        );
        const first = text.indexOf(oldText);
        if (first < 0) {
          throw new AgentError(
            'EDIT_TEXT_NOT_FOUND',
            `old_text was not found in ${path}`
          );
        }
        const occurrences = text.split(oldText).length - 1;
        if (occurrences > 1 && input.replace_all !== true) {
          throw new AgentError(
            'EDIT_TEXT_AMBIGUOUS',
            `old_text occurs ${occurrences} times in ${path}; pass replace_all or provide more context`
          );
        }
        const updated =
          input.replace_all === true
            ? text.split(oldText).join(newText)
            : `${text.slice(0, first)}${newText}${text.slice(first + oldText.length)}`;
        const expected = optionalNumber(input, 'expected_version');
        return workspace.fs.write(path, new TextEncoder().encode(updated), {
          signal: invocation.signal,
          expectedVersion: expected ?? info.version,
        });
      }
    ),
    tool(
      'append_file',
      'Append UTF-8 text to a file, creating it when absent.',
      schema(
        {
          path: { type: 'string' },
          text: { type: 'string' },
          expected_version: { type: 'integer' },
        },
        ['path', 'text']
      ),
      'write',
      'write',
      async (input, invocation) => {
        const path = requiredString(input, 'path');
        const info = await workspace.fs.stat(path, invocation.signal);
        const existing = info
          ? new TextDecoder().decode(
              await workspace.fs.read(path, { signal: invocation.signal })
            )
          : '';
        const expected = optionalNumber(input, 'expected_version');
        return workspace.fs.write(
          path,
          new TextEncoder().encode(
            `${existing}${typeof input.text === 'string' ? input.text : ''}`
          ),
          {
            signal: invocation.signal,
            ...(expected !== undefined
              ? { expectedVersion: expected }
              : info
                ? { expectedVersion: info.version }
                : {}),
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
    ...createPatchTools(workspace.fs),
    tool(
      'exec',
      'Execute the supported Virtual Shell subset without host Bash.',
      schema(
        {
          script: { type: 'string' },
          command: { type: 'string' },
          args: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string' },
          stdin: { type: 'string' },
        }
      ),
      'dangerous',
      'execute',
      async (input, invocation) => {
        const script =
          optionalString(input, 'script') ??
          buildCommandScript(input);
        if (!script) {
          throw new AgentError(
            'TOOL_ARGUMENTS_INVALID',
            'exec requires script or command'
          );
        }
        return workspace.shell.execute(script, {
          signal: invocation.signal,
          ...(optionalString(input, 'stdin') === undefined
            ? {}
            : { stdin: optionalString(input, 'stdin') }),
        }) as unknown as JsonValue;
      }
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
    ...createGitTools(git),
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

function buildCommandScript(input: ObjectInput): string | undefined {
  const command = optionalString(input, 'command');
  if (!command) return undefined;
  const args = stringArray(input.args) ?? [];
  const cwd = optionalString(input, 'cwd');
  const invocation = [command, ...args].map(shellQuote).join(' ');
  return cwd
    ? `cd ${shellQuote(cwd)}; ${invocation}`
    : invocation;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
