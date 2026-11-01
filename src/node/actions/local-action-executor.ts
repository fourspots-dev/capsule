import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolve, sep } from 'node:path';
import { AgentError } from '../../core/errors';

export interface LocalActionExecutionRequest {
  executable: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal: AbortSignal;
}

export interface LocalActionExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface LocalActionExecutorOptions {
  workspaceRoot: string;
  executableAllowlist: readonly string[];
  environmentAllowlist?: readonly string[];
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
}

/**
 * Executes an explicitly allowed executable with argv, a fenced cwd and a
 * compact environment. There is no shell interpolation or fail-open path.
 */
export class LocalActionExecutor {
  private readonly workspaceRoot: string;
  private readonly executables: ReadonlySet<string>;
  private readonly environmentAllowlist: ReadonlySet<string>;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly killGraceMs: number;

  constructor(options: LocalActionExecutorOptions) {
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.executables = new Set(
      options.executableAllowlist.map((item) => item.trim()).filter(Boolean)
    );
    if (this.executables.size === 0) {
      throw new Error('LocalActionExecutor requires an executable allowlist');
    }
    this.environmentAllowlist = new Set(
      options.environmentAllowlist ?? [
        'PATH',
        'HOME',
        'TMPDIR',
        'TEMP',
        'TMP',
        'SystemRoot',
        'WINDIR',
      ]
    );
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 300_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.killGraceMs = options.killGraceMs ?? 250;
  }

  execute(
    request: LocalActionExecutionRequest
  ): Promise<LocalActionExecutionResult> {
    if (request.signal.aborted) {
      return Promise.reject(cancelledError());
    }
    if (
      !request.executable ||
      /[\\/]/.test(request.executable) ||
      !this.executables.has(request.executable)
    ) {
      return Promise.reject(
        new AgentError(
          'ACTION_EXECUTABLE_DENIED',
          `Executable is not allowlisted: ${request.executable}`
        )
      );
    }
    const cwd = this.fencedCwd(request.cwd);
    if (!cwd) {
      return Promise.reject(
        new AgentError(
          'ACTION_CWD_DENIED',
          `Action cwd escapes the workspace: ${request.cwd ?? ''}`
        )
      );
    }

    const startedAt = Date.now();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? this.maxOutputBytes;
    return new Promise((resolvePromise, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(request.executable, [...request.args], {
          cwd,
          env: this.environment(request.env),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        reject(mapSpawnError(error));
        return;
      }

      let stdout = '';
      let stderr = '';
      let truncated = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const append = (current: string, chunk: Buffer): string => {
        const used = Buffer.byteLength(current);
        if (used >= maxOutputBytes) {
          truncated = true;
          return current;
        }
        const remaining = maxOutputBytes - used;
        if (chunk.byteLength > remaining) truncated = true;
        return current + chunk.subarray(0, remaining).toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });

      const cleanup = () => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        request.signal.removeEventListener('abort', abort);
      };
      const finish = (
        callback: () => void,
        terminate = false
      ): void => {
        if (settled) return;
        settled = true;
        cleanup();
        if (terminate) {
          stopProcessTree(child, this.killGraceMs).then(() => {
            killTimer = undefined;
          });
        }
        callback();
      };
      const abort = () => {
        finish(() => reject(cancelledError()), true);
      };
      request.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => {
        finish(
          () =>
            reject(
              new AgentError(
                'ACTION_TIMEOUT',
                `Action timed out after ${timeoutMs}ms`
              )
            ),
          true
        );
      }, timeoutMs);

      child.once('error', (error) => {
        finish(() => reject(mapSpawnError(error)));
      });
      child.once('close', (code) => {
        finish(() =>
          resolvePromise({
            exitCode: code ?? 1,
            stdout,
            stderr,
            truncated,
            durationMs: Date.now() - startedAt,
          })
        );
      });
      if (request.stdin) child.stdin.end(Buffer.from(request.stdin));
      else child.stdin.end();
    });
  }

  private fencedCwd(value?: string): string | undefined {
    const target = resolve(this.workspaceRoot, value ?? '.');
    if (
      target !== this.workspaceRoot &&
      !target.startsWith(`${this.workspaceRoot}${sep}`)
    ) {
      return undefined;
    }
    return target;
  }

  private environment(
    overrides: Readonly<Record<string, string>> = {}
  ): Record<string, string> {
    const environment: Record<string, string> = {};
    for (const key of this.environmentAllowlist) {
      const value = process.env[key];
      if (value !== undefined) environment[key] = value;
    }
    for (const [key, value] of Object.entries(overrides)) {
      if (this.environmentAllowlist.has(key)) environment[key] = value;
    }
    environment.CI = '1';
    return environment;
  }
}

async function stopProcessTree(
  child: ChildProcessWithoutNullStreams,
  graceMs: number
): Promise<void> {
  if (!child.pid) return;
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid!, name);
    } catch {
      try {
        child.kill(name);
      } catch {
        // The process tree has already exited.
      }
    }
  };
  signal('SIGTERM');
  await new Promise<void>((resolvePromise) => {
    const timer = setTimeout(resolvePromise, graceMs);
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
  if (child.exitCode === null && !child.killed) signal('SIGKILL');
}

function cancelledError(): AgentError {
  return new AgentError('ACTION_CANCELLED', 'Application Action was cancelled');
}

function mapSpawnError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError(
    'ACTION_PROVIDER_CRASHED',
    error instanceof Error ? error.message : String(error)
  );
}
