import { AgentError } from '../core/errors';
import type { SandboxProvider, WorkspaceLease } from '../core/sandbox-provider';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';

type ObjectInput = Record<string, JsonValue>;

export function createSandboxTools(
  provider: SandboxProvider,
  lease: WorkspaceLease
): ToolDefinition[] {
  const ptys = new Map<string, import('../core/sandbox-provider').PtySession>();
  return [
    tool(
      'read_file',
      'Read a UTF-8 file from the task sandbox.',
      schema({ path: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] } }, ['path']),
      'read',
      'read',
      async (input, invocation) => {
        const file = await provider.readFile(lease, requiredString(input, 'path'), invocation.signal);
        return input.encoding === 'base64'
          ? { path: file.path, dataBase64: bytesToBase64(file.data), bytes: file.data.byteLength }
          : { path: file.path, text: new TextDecoder().decode(file.data), bytes: file.data.byteLength };
      }
    ),
    tool(
      'write_file',
      'Write a UTF-8 or base64 file in the task sandbox.',
      schema({
        path: { type: 'string' },
        text: { type: 'string' },
        dataBase64: { type: 'string' },
      }, ['path']),
      'write',
      'write',
      async (input, invocation) => {
        const text = optionalString(input, 'text');
        const base64 = optionalString(input, 'dataBase64');
        if (text === undefined && base64 === undefined) {
          throw new AgentError('TOOL_ARGUMENTS_INVALID', 'write_file requires text or dataBase64');
        }
        const data =
          base64 !== undefined ? base64ToBytes(base64) : new TextEncoder().encode(text);
        const file = await provider.writeFile(lease, requiredString(input, 'path'), data, {
          signal: invocation.signal,
          idempotencyKey: invocation.call.id,
        });
        return { path: file.path, bytes: file.data.byteLength, modifiedAt: file.modifiedAt };
      }
    ),
    tool(
      'list_files',
      'List files below a sandbox directory.',
      schema({ path: { type: 'string' } }),
      'read',
      'read',
      async (input, invocation) => {
        const files = await provider.listFiles(
          lease,
          optionalString(input, 'path') ?? '.',
          invocation.signal
        );
        return files.map((file) => ({
          path: file.path,
          bytes: file.data.byteLength,
          modifiedAt: file.modifiedAt,
        }));
      }
    ),
    tool(
      'delete_file',
      'Delete a file in the task sandbox.',
      schema({ path: { type: 'string' } }, ['path']),
      'write',
      'write',
      async (input, invocation) => ({
        deleted: await provider.deleteFile(lease, requiredString(input, 'path'), {
          signal: invocation.signal,
          idempotencyKey: invocation.call.id,
        }),
      })
    ),
    tool(
      'exec',
      'Execute a command in the task sandbox with timeout and cancellation.',
      schema({
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        timeout_ms: { type: 'integer' },
      }, ['command']),
      'dangerous',
      'execute',
      async (input, invocation) => {
        const args = Array.isArray(input.args) ? input.args.map(String) : [];
        const result = await provider.exec(lease, {
          command: requiredString(input, 'command'),
          args,
          cwd: optionalString(input, 'cwd'),
          timeoutMs: optionalNumber(input, 'timeout_ms'),
          idempotencyKey: invocation.call.id,
          signal: invocation.signal,
        });
        return result as unknown as JsonValue;
      }
    ),
    tool(
      'run_tests',
      'Run a test command and return a structured test report.',
      schema({
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        timeout_ms: { type: 'integer' },
      }, ['command']),
      'dangerous',
      'execute',
      async (input, invocation) => {
        const result = await provider.exec(lease, {
          command: requiredString(input, 'command'),
          args: Array.isArray(input.args) ? input.args.map(String) : [],
          timeoutMs: optionalNumber(input, 'timeout_ms') ?? 120_000,
          idempotencyKey: invocation.call.id,
          signal: invocation.signal,
        });
        return {
          passed: result.exitCode === 0,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        };
      }
    ),
    tool(
      'terminal_open',
      'Open a persistent PTY in the task sandbox.',
      schema({
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string' },
        cols: { type: 'integer' },
        rows: { type: 'integer' },
      }, ['command']),
      'dangerous',
      'execute',
      async (input, invocation) => {
        if (!provider.openPty) {
          throw new AgentError('SANDBOX_PTY_UNSUPPORTED', 'This sandbox has no PTY provider');
        }
        const pty = await provider.openPty(lease, {
          command: requiredString(input, 'command'),
          args: Array.isArray(input.args) ? input.args.map(String) : [],
          cwd: optionalString(input, 'cwd'),
          cols: optionalNumber(input, 'cols') ?? 80,
          rows: optionalNumber(input, 'rows') ?? 24,
          signal: invocation.signal,
        });
        ptys.set(pty.id, pty);
        return {
          ptyId: pty.id,
          initialOutput: (await pty.read()) as unknown as JsonValue,
        };
      }
    ),
    tool(
      'terminal_write',
      'Write input to an open sandbox PTY.',
      schema({
        ptyId: { type: 'string' },
        data: { type: 'string' },
      }, ['ptyId', 'data']),
      'dangerous',
      'execute',
      async (input, invocation) => {
        const pty = ptys.get(requiredString(input, 'ptyId'));
        if (!pty) throw new AgentError('PTY_NOT_FOUND', 'PTY session not found');
        await pty.write(requiredString(input, 'data'), invocation.signal);
        return { written: true };
      }
    ),
    tool(
      'terminal_read',
      'Read pending PTY output.',
      schema({
        ptyId: { type: 'string' },
        timeout_ms: { type: 'integer' },
      }, ['ptyId']),
      'read',
      'read',
      async (input, invocation) => {
        const pty = ptys.get(requiredString(input, 'ptyId'));
        if (!pty) throw new AgentError('PTY_NOT_FOUND', 'PTY session not found');
        return (await pty.read(
          optionalNumber(input, 'timeout_ms') ?? 0,
          invocation.signal
        )) as unknown as JsonValue;
      }
    ),
    tool(
      'terminal_close',
      'Close an open sandbox PTY.',
      schema({ ptyId: { type: 'string' } }, ['ptyId']),
      'write',
      'write',
      async (input) => {
        const ptyId = requiredString(input, 'ptyId');
        const pty = ptys.get(ptyId);
        if (pty) await pty.close();
        ptys.delete(ptyId);
        return { closed: Boolean(pty) };
      }
    ),
  ];
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, JsonValue>,
  risk: ToolDefinition['risk'],
  effect: NonNullable<ToolDefinition['effect']>,
  execute: (input: ObjectInput, invocation: ToolInvocation) => Promise<JsonValue | unknown>
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    risk,
    effect,
    capabilities: [`sandbox:${effect}`, `workspace:${leaseScope(effect)}`],
    executionMode: effect === 'read' ? 'parallel' : 'sequential',
    replay: effect === 'read' ? 'safe' : 'never',
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
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(input: ObjectInput, key: string): number | undefined {
  return typeof input[key] === 'number' ? input[key] : undefined;
}

function leaseScope(effect: NonNullable<ToolDefinition['effect']>): string {
  return effect === 'execute' || effect === 'network' ? 'execute' : effect;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
