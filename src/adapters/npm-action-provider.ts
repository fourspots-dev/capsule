import { spawn } from 'node:child_process';
import { AgentError } from '../core/errors';
import type {
  HostActionContext,
  HostActionDescriptor,
  HostActionResult,
  HostActionProvider,
} from '../platform/host-action';
import type { JsonValue } from '../core/types';

export interface NpmScriptActionDefinition {
  id: string;
  title: string;
  description: string;
  script: string;
  timeoutMs?: number;
}

export interface NpmActionProviderOptions {
  workspaceRoot: string;
  scripts: readonly NpmScriptActionDefinition[];
  maxOutputBytes?: number;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export class NpmScriptActionProvider implements HostActionProvider {
  private readonly scripts: Map<string, NpmScriptActionDefinition>;
  private readonly maxOutputBytes: number;

  constructor(private readonly options: NpmActionProviderOptions) {
    this.scripts = new Map();
    for (const script of options.scripts) {
      if (this.scripts.has(script.id)) {
        throw new Error(`Duplicate npm action: ${script.id}`);
      }
      this.scripts.set(script.id, script);
    }
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
  }

  async describe(): Promise<readonly HostActionDescriptor[]> {
    return [...this.scripts.values()].map((script) => ({
      id: script.id,
      version: '1.0.0',
      title: script.title,
      description: script.description,
      inputSchema: {
        type: 'object',
        properties: {},
      },
      outputSchema: {
        type: 'object',
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      effects: ['execute', 'read'],
      risk: 'dangerous',
      timeoutMs: script.timeoutMs ?? 300_000,
      probe: async () => ({ state: 'available' }),
    }));
  }

  async invoke(
    actionId: string,
    _input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult> {
    const action = this.scripts.get(actionId);
    if (!action) throw new Error(`Unknown npm action: ${actionId}`);
    const result = await runCommand(
      'npm',
      ['run', action.script],
      this.options.workspaceRoot,
      context.signal,
      action.timeoutMs ?? 300_000,
      this.maxOutputBytes
    );
    if (result.exitCode !== 0) {
      throw new AgentError(
        'ACTION_FAILED',
        `npm script ${action.script} failed with exit code ${result.exitCode}`,
        {
          details: {
            actionId,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        }
      );
    }
    return {
      value: {
        actionId,
        script: action.script,
        ...result,
      },
      truncated: result.truncated,
    };
  }
}

function runCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd,
      env: compactEnvironment({
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        CI: '1',
      }),
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let truncated = false;
    let settled = false;
    const append = (current: string, chunk: Buffer): string => {
      if (Buffer.byteLength(current) >= maxOutputBytes) {
        truncated = true;
        return current;
      }
      const remaining = maxOutputBytes - Buffer.byteLength(current);
      const value = chunk.subarray(0, remaining).toString('utf8');
      if (chunk.byteLength > remaining) truncated = true;
      return current + value;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      callback();
    };
    const abort = () => {
      terminate(child);
      finish(() => reject(abortError()));
    };
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => {
      terminate(child);
      finish(() =>
        reject(new Error(`Action timed out after ${timeoutMs}ms`))
      );
    }, timeoutMs);
    child.on('error', (error) =>
      finish(() => reject(error))
    );
    child.on('close', (code) =>
      finish(() =>
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
          truncated,
        })
      )
    );
  });
}

function terminate(child: ReturnType<typeof spawn>): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

function compactEnvironment(
  values: Record<string, string | undefined>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] => Boolean(entry[1])
    )
  );
}

function abortError(): Error {
  const error = new Error('Action was cancelled');
  error.name = 'AbortError';
  return error;
}
