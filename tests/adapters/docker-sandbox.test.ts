import { describe, expect, it, vi } from 'vitest';
import {
  DockerSandboxProvider,
  type DockerCommandRequest,
  type DockerCommandResult,
  type DockerCommandRunner,
  type DockerPtyProcess,
  type DockerPtyRunner,
} from '../../src/adapters/docker-sandbox';
import type { PtyEvent } from '../../src/core/sandbox-provider';

interface FakeState {
  files: Map<string, Uint8Array>;
  volumeCreated: boolean;
  containerRunning: boolean;
}

class FakeDockerRunner implements DockerCommandRunner {
  readonly calls: DockerCommandRequest[] = [];
  readonly state: FakeState = {
    files: new Map(),
    volumeCreated: false,
    containerRunning: false,
  };

  async run(request: DockerCommandRequest): Promise<DockerCommandResult> {
    this.calls.push(request);
    if (request.signal?.aborted) throw new Error('aborted');
    const [command, subcommand] = request.args;
    if (command === 'volume' && subcommand === 'create') {
      this.state.volumeCreated = true;
      return ok(request.args[2]);
    }
    if (command === 'volume' && subcommand === 'rm') {
      this.state.volumeCreated = false;
      this.state.files.clear();
      return ok();
    }
    if (command === 'run') {
      this.state.containerRunning = true;
      return ok('container-id');
    }
    if (command === 'rm') {
      this.state.containerRunning = false;
      return ok();
    }
    if (command !== 'exec') return fail(2, `unsupported docker command: ${request.args.join(' ')}`);

    const executableIndex = findExecutableIndex(request.args);
    const executable = request.args[executableIndex];
    const args = request.args.slice(executableIndex + 1);
    if (executable === 'base64') {
      const data = this.state.files.get(args[0]);
      return data ? ok(bytesToBase64(data)) : fail(1, 'No such file');
    }
    if (executable === 'sh' && args[0] === '-lc') {
      const target = args.at(-1)!;
      this.state.files.set(target, new Uint8Array(request.stdin ?? new Uint8Array()));
      return ok();
    }
    if (executable === 'find') {
      if (args.includes('-delete')) {
        this.state.files.clear();
        return ok();
      }
      const root = args[0];
      return ok(
        [...this.state.files.keys()]
          .filter((path) => path === root || path.startsWith(`${root}/`))
          .join('\n')
      );
    }
    if (executable === 'rm') {
      this.state.files.delete(args.at(-1)!);
      return ok();
    }
    if (executable === 'echo') return ok(args.join(' '));
    if (executable === 'block') {
      await new Promise<void>((_resolve, reject) => {
        request.signal?.addEventListener(
          'abort',
          () => reject(new Error('aborted')),
          { once: true }
        );
      });
    }
    return fail(127, `${executable}: not found`);
  }
}

function ok(stdout = ''): DockerCommandResult {
  return {
    exitCode: 0,
    stdout,
    stderr: '',
    durationMs: 1,
  };
}

function fail(exitCode: number, stderr: string): DockerCommandResult {
  return { exitCode, stdout: '', stderr, durationMs: 1 };
}

function findExecutableIndex(args: string[]): number {
  for (let index = 1; index < args.length; index += 1) {
    if (args[index] === '--workdir' || args[index] === '-i') {
      if (args[index] === '--workdir') index += 1;
      continue;
    }
    if (index === 1) return 2;
    return index + 1;
  }
  return args.length;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function provider(runner: FakeDockerRunner) {
  let now = 100;
  let sequence = 0;
  const provider = new DockerSandboxProvider({
    runner,
    image: 'test-image',
    now: () => now,
    ids: { next: (prefix) => `${prefix}_${++sequence}` },
    memoryLimit: '512m',
    cpuLimit: '0.5',
    pidsLimit: 64,
    defaultTimeoutMs: 20,
  });
  return {
    provider,
    setNow(value: number) {
      now = value;
    },
  };
}

describe('DockerSandboxProvider', () => {
  it('creates an isolated container and volume with restrictive options', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox } = provider(runner);
    const lease = await sandbox.createWorkspace({
      sessionId: 'session_1',
      readOnly: false,
      ttlMs: 1_000,
    });
    expect(lease).toMatchObject({
      sessionId: 'session_1',
      workspaceRoot: '/workspace',
      fencingToken: 1,
      readOnly: false,
    });
    const run = runner.calls.find((call) => call.args[0] === 'run')!;
    expect(run.args).toEqual(
      expect.arrayContaining([
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '--memory',
        '512m',
        '--cpus',
        '0.5',
        '--pids-limit',
        '64',
      ])
    );
    expect(run.args).toContain('tinyai.session=session_1');
    expect(run.args.at(-4)).toBe('test-image');
  });

  it('can bind-mount an explicit host workspace without a named volume', async () => {
    const runner = new FakeDockerRunner();
    const sandbox = new DockerSandboxProvider({
      runner,
      image: 'test-image',
      workspaceHostPath: '/tmp/project',
      ids: { next: (prefix) => `${prefix}_1` },
    });
    const lease = await sandbox.createWorkspace({ sessionId: 'session_1' });
    expect(
      runner.calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'create')
    ).toBe(false);
    expect(
      runner.calls.find((call) => call.args[0] === 'run')?.args
    ).toContain('type=bind,source=/tmp/project,target=/workspace');
    await sandbox.release(lease);
    expect(
      runner.calls.some((call) => call.args[0] === 'volume' && call.args[1] === 'rm')
    ).toBe(false);
  });

  it('can attach only to an internal proxy network with explicit non-secret env', async () => {
    const runner = new FakeDockerRunner();
    const sandbox = new DockerSandboxProvider({
      runner,
      image: 'test-image',
      networkName: 'tinyai-internal',
      containerEnvironment: {
        HTTP_PROXY: 'http://192.0.2.10:8080',
        HTTPS_PROXY: 'http://192.0.2.10:8080',
      },
      ids: { next: (prefix) => `${prefix}_1` },
    });
    await sandbox.createWorkspace({ sessionId: 's' });
    const args = runner.calls.find((call) => call.args[0] === 'run')!.args;
    expect(args).toEqual(
      expect.arrayContaining([
        '--network',
        'tinyai-internal',
        '--env',
        'HTTP_PROXY=http://192.0.2.10:8080',
      ])
    );
    expect(args).not.toContain('--privileged');
  });

  it('supports write/read/list/delete and idempotent effects', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox } = provider(runner);
    const lease = await sandbox.createWorkspace({ sessionId: 'session_1' });
    await sandbox.writeFile(lease, 'src/a.ts', new TextEncoder().encode('hello'), {
      idempotencyKey: 'write-a',
    });
    await sandbox.writeFile(lease, 'src/a.ts', new TextEncoder().encode('ignored'), {
      idempotencyKey: 'write-a',
    });
    expect(new TextDecoder().decode((await sandbox.readFile(lease, 'src/a.ts')).data)).toBe(
      'hello'
    );
    expect((await sandbox.listFiles(lease, 'src')).map((file) => file.path)).toEqual([
      '/workspace/src/a.ts',
    ]);
    expect(await sandbox.deleteFile(lease, 'src/a.ts', { idempotencyKey: 'delete-a' })).toBe(true);
    expect(await sandbox.deleteFile(lease, 'src/a.ts', { idempotencyKey: 'delete-a' })).toBe(true);
    await expect(sandbox.readFile(lease, 'src/a.ts')).rejects.toMatchObject({
      code: 'DOCKER_FILE_READ_FAILED',
    });
  });

  it('runs commands with cwd and maps timeout/abort to cancellation', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox } = provider(runner);
    const lease = await sandbox.createWorkspace({ sessionId: 'session_1' });
    const echo = await sandbox.exec(lease, {
      command: 'echo',
      args: ['hello'],
      cwd: 'src',
      idempotencyKey: 'echo',
    });
    expect(echo).toMatchObject({ exitCode: 0, stdout: 'hello' });
    const execCall = runner.calls.find(
      (call) => call.args.includes('echo') && call.args.includes('hello')
    )!;
    expect(execCall.args).toEqual(
      expect.arrayContaining(['--workdir', '/workspace/src', 'echo', 'hello'])
    );

    const controller = new AbortController();
    const pending = sandbox.exec(lease, {
      command: 'block',
      signal: controller.signal,
      timeoutMs: 1_000,
    });
    controller.abort();
    await expect(pending).rejects.toThrow(/aborted|timed out/);
  });

  it('snapshots and restores workspace files', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox } = provider(runner);
    const lease = await sandbox.createWorkspace({ sessionId: 'session_1' });
    await sandbox.writeFile(lease, 'a.txt', new TextEncoder().encode('one'));
    const checkpoint = await sandbox.checkpoint(lease);
    await sandbox.writeFile(lease, 'b.txt', new TextEncoder().encode('two'));
    await sandbox.restore(lease, checkpoint.checkpointId);
    expect((await sandbox.listFiles(lease)).map((file) => file.path)).toEqual([
      '/workspace/a.txt',
    ]);
  });

  it('rejects stale/expired leases and is idempotent on release', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox, setNow } = provider(runner);
    const lease = await sandbox.createWorkspace({ sessionId: 'session_1', ttlMs: 10 });
    await expect(
      sandbox.readFile({ ...lease, fencingToken: 999 }, 'a')
    ).rejects.toMatchObject({ code: 'SANDBOX_LEASE_INVALID' });
    setNow(200);
    await expect(sandbox.readFile(lease, 'a')).rejects.toMatchObject({
      code: 'SANDBOX_LEASE_EXPIRED',
    });
    await expect(sandbox.release(lease)).resolves.toBeUndefined();

    const active = await sandbox.createWorkspace({ sessionId: 'session_2' });
    await sandbox.release(active);
    await expect(sandbox.release(active)).resolves.toBeUndefined();
    await expect(sandbox.readFile(active, 'a')).rejects.toMatchObject({
      code: 'SANDBOX_RELEASED',
    });
    expect(runner.state.containerRunning).toBe(false);
    expect(runner.state.volumeCreated).toBe(false);
  });

  it('fails closed on path escape and read-only execution', async () => {
    const runner = new FakeDockerRunner();
    const { provider: sandbox } = provider(runner);
    const readOnly = await sandbox.createWorkspace({
      sessionId: 'session_1',
      readOnly: true,
    });
    await expect(
      sandbox.writeFile(readOnly, 'a', new Uint8Array())
    ).rejects.toMatchObject({ code: 'SANDBOX_READ_ONLY' });
    await expect(
      sandbox.exec(readOnly, { command: 'echo' })
    ).rejects.toMatchObject({ code: 'SANDBOX_READ_ONLY' });
    const writable = await sandbox.createWorkspace({ sessionId: 'session_2' });
    await expect(sandbox.readFile(writable, '../../etc/passwd')).rejects.toMatchObject({
      code: 'SANDBOX_PATH_ESCAPE',
    });
  });

  it('opens and releases PTY sessions through an injected Docker PTY runner', async () => {
    const runner = new FakeDockerRunner();
    const opened: string[][] = [];
    const ptyRunner: DockerPtyRunner = {
      open: async (request) => {
        opened.push(request.args);
        const listeners = new Set<(event: PtyEvent) => void>();
        const buffered: PtyEvent[] = [];
        const emit = (event: PtyEvent) => {
          if (listeners.size === 0) buffered.push(event);
          else listeners.forEach((listener) => listener(event));
        };
        emit({ type: 'data', stream: 'stdout', data: '$ ready\r\n' });
        return {
          write: async (data) => emit({ type: 'data', stream: 'stdout', data }),
          resize: async () => undefined,
          close: async () => emit({ type: 'exit', exitCode: 0 }),
          onEvent: (listener) => {
            listeners.add(listener);
            for (const event of buffered.splice(0)) listener(event);
            return () => listeners.delete(listener);
          },
        } satisfies DockerPtyProcess;
      },
    };
    const sandbox = new DockerSandboxProvider({
      runner,
      ptyRunner,
      image: 'test-image',
      ids: { next: (prefix) => `${prefix}_1` },
    });
    const lease = await sandbox.createWorkspace({ sessionId: 's' });
    const pty = await sandbox.openPty!(lease, {
      command: 'sh',
      cwd: 'src',
      cols: 80,
      rows: 24,
    });
    expect(await pty.read()).toEqual([
      { type: 'data', stream: 'stdout', data: '$ ready\r\n' },
    ]);
    await pty.write('echo ok\n');
    expect(await pty.read()).toEqual([
      { type: 'data', stream: 'stdout', data: 'echo ok\n' },
    ]);
    expect(opened[0]).toEqual(
      expect.arrayContaining(['exec', '-i', '--workdir', '/workspace/src', 'script'])
    );
    await sandbox.release(lease);
    await expect(pty.read()).rejects.toMatchObject({ code: 'PTY_CLOSED' });
  });
});
