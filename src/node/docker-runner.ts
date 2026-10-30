import { spawn } from 'node:child_process';
import type {
  DockerCommandRequest,
  DockerCommandResult,
  DockerCommandRunner,
  DockerPtyProcess,
  DockerPtyRunner,
} from '../adapters/docker-sandbox';
import type { PtyEvent } from '../core/sandbox-provider';

export class NodeDockerCommandRunner implements DockerCommandRunner {
  constructor(
    private readonly dockerBinary = 'docker',
    private readonly maxOutputBytes = 1_000_000
  ) {}

  run(request: DockerCommandRequest): Promise<DockerCommandResult> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(this.dockerBinary, request.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: request.signal,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
        },
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTruncated = false;
      let stderrTruncated = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (stdoutBytes >= this.maxOutputBytes) {
          stdoutTruncated = true;
          return;
        }
        const remaining = this.maxOutputBytes - stdoutBytes;
        const kept = chunk.subarray(0, remaining);
        stdout.push(kept);
        stdoutBytes += kept.byteLength;
        stdoutTruncated ||= chunk.byteLength > kept.byteLength;
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderrBytes >= this.maxOutputBytes) {
          stderrTruncated = true;
          return;
        }
        const remaining = this.maxOutputBytes - stderrBytes;
        const kept = chunk.subarray(0, remaining);
        stderr.push(kept);
        stderrBytes += kept.byteLength;
        stderrTruncated ||= chunk.byteLength > kept.byteLength;
      });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        resolve({
          exitCode: code ?? (signal ? 124 : 1),
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: Date.now() - started,
          stdoutTruncated,
          stderrTruncated,
        });
      });
      if (request.stdin?.byteLength) child.stdin.write(Buffer.from(request.stdin));
      child.stdin.end();
    });
  }
}

export class NodeDockerPtyRunner implements DockerPtyRunner {
  constructor(private readonly dockerBinary = 'docker') {}

  async open(request: {
    args: string[];
    signal?: AbortSignal;
  }): Promise<DockerPtyProcess> {
    const child = spawn(this.dockerBinary, request.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: request.signal,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: process.env.HOME ?? '',
      },
    });
    const listeners = new Set<(event: PtyEvent) => void>();
    const buffered: PtyEvent[] = [];
    const emit = (event: PtyEvent): void => {
      if (listeners.size === 0) buffered.push(event);
      else for (const listener of listeners) listener(event);
    };
    child.stdout.on('data', (chunk: Buffer) =>
      emit({ type: 'data', stream: 'stdout', data: chunk.toString('utf8') })
    );
    child.stderr.on('data', (chunk: Buffer) =>
      emit({ type: 'data', stream: 'stderr', data: chunk.toString('utf8') })
    );
    child.on('close', (code, signal) =>
      emit({ type: 'exit', exitCode: code ?? (signal ? 124 : 1) })
    );
    return {
      write: async (data) => {
        if (!child.stdin.destroyed) child.stdin.write(data);
      },
      resize: async () => undefined,
      close: async () => {
        if (!child.killed) child.kill('SIGTERM');
      },
      onEvent: (listener) => {
        listeners.add(listener);
        for (const event of buffered.splice(0)) listener(event);
        return () => listeners.delete(listener);
      },
    };
  }
}
