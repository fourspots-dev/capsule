import { AgentError } from '../core/errors';
import type {
  ExecRequest,
  ExecResult,
  PtyEvent,
  PtyOpenRequest,
  PtySession,
  SandboxCheckpoint,
  SandboxFile,
  SandboxProvider,
  WorkspaceLease,
} from '../core/sandbox-provider';

export interface DockerCommandRequest {
  args: string[];
  stdin?: Uint8Array;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
}

export interface DockerCommandRunner {
  run(request: DockerCommandRequest): Promise<DockerCommandResult>;
}

export interface DockerPtyProcess {
  write(data: string): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  close(): Promise<void>;
  onEvent(listener: (event: PtyEvent) => void): () => void;
}

export interface DockerPtyRunner {
  open(
    request: { args: string[]; signal?: AbortSignal },
  ): Promise<DockerPtyProcess>;
}

export interface DockerSandboxOptions {
  runner: DockerCommandRunner;
  ptyRunner?: DockerPtyRunner;
  image?: string;
  workspaceRoot?: string;
  workspaceHostPath?: string;
  now?: () => number;
  ids?: { next(prefix: string): string };
  memoryLimit?: string;
  cpuLimit?: string;
  pidsLimit?: number;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  networkName?: string;
  containerEnvironment?: Record<string, string>;
}

interface CachedCheckpoint {
  metadata: SandboxCheckpoint;
  files: Map<string, SandboxFile>;
}

interface WorkspaceState {
  lease: WorkspaceLease;
  containerName: string;
  volumeName?: string;
  bindWorkspacePath?: string;
  checkpoints: Map<string, CachedCheckpoint>;
  idempotency: Map<string, unknown>;
  released: boolean;
  ptys: Set<PtySession>;
}

export class DockerSandboxProvider implements SandboxProvider {
  private readonly runner: DockerCommandRunner;
  private readonly ptyRunner?: DockerPtyRunner;
  private readonly image: string;
  private readonly workspaceRoot: string;
  private readonly workspaceHostPath?: string;
  private readonly now: () => number;
  private readonly ids: { next(prefix: string): string };
  private readonly memoryLimit: string;
  private readonly cpuLimit: string;
  private readonly pidsLimit: number;
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly networkName: string;
  private readonly containerEnvironment: Record<string, string>;
  private readonly workspaces = new Map<string, WorkspaceState>();
  private sequence = 0;

  constructor(options: DockerSandboxOptions) {
    this.runner = options.runner;
    this.ptyRunner = options.ptyRunner;
    this.image = options.image ?? 'node:22-bookworm-slim';
    this.workspaceRoot = normalizeContainerRoot(options.workspaceRoot ?? '/workspace');
    this.workspaceHostPath = options.workspaceHostPath;
    this.now = options.now ?? (() => Date.now());
    this.ids = options.ids ?? {
      next: (prefix) => `${prefix}_${++this.sequence}`,
    };
    this.memoryLimit = options.memoryLimit ?? '1g';
    this.cpuLimit = options.cpuLimit ?? '1';
    this.pidsLimit = options.pidsLimit ?? 256;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.networkName = options.networkName ?? 'none';
    this.containerEnvironment = { ...(options.containerEnvironment ?? {}) };
  }

  async createWorkspace(
    request: {
      sessionId: string;
      workspaceRoot?: string;
      readOnly?: boolean;
      ttlMs?: number;
      budget?: Record<string, number>;
    },
    signal?: AbortSignal
  ): Promise<WorkspaceLease> {
    assertActive(signal);
    if (request.workspaceRoot && normalizeContainerRoot(request.workspaceRoot) !== this.workspaceRoot) {
      throw new AgentError(
        'DOCKER_WORKSPACE_ROOT_FIXED',
        `This provider always mounts the workspace at ${this.workspaceRoot}`
      );
    }
    const leaseId = this.ids.next('docker_lease');
    const suffix = sanitizeName(leaseId);
    const containerName = `tinyai-${suffix}`;
    const volumeName = this.workspaceHostPath ? undefined : `tinyai-ws-${suffix}`;
    const createdAt = this.now();
    const lease: WorkspaceLease = {
      leaseId,
      sessionId: request.sessionId,
      workspaceRoot: this.workspaceRoot,
      fencingToken: 1,
      createdAt,
      expiresAt: createdAt + (request.ttlMs ?? 3_600_000),
      readOnly: request.readOnly ?? false,
    };

    if (volumeName) {
      await this.expectSuccess(
        'DOCKER_VOLUME_CREATE_FAILED',
        { args: ['volume', 'create', volumeName], signal },
        'CREATE_VOLUME'
      );
    }
    try {
      await this.expectSuccess(
        'DOCKER_CONTAINER_CREATE_FAILED',
        {
          args: [
            'run',
            '--rm',
            '-d',
            '--name',
            containerName,
            '--network',
            this.networkName,
            ...Object.entries(this.containerEnvironment).flatMap(([name, value]) => [
              '--env',
              `${name}=${value}`,
            ]),
            '--read-only',
            '--tmpfs',
            '/tmp:rw,noexec,nosuid,size=256m',
            '--memory',
            this.memoryLimit,
            '--cpus',
            this.cpuLimit,
            '--pids-limit',
            String(this.pidsLimit),
            '--cap-drop',
            'ALL',
            '--security-opt',
            'no-new-privileges',
            '--mount',
            this.workspaceHostPath
              ? `type=bind,source=${this.workspaceHostPath},target=${this.workspaceRoot}`
              : `type=volume,source=${volumeName},target=${this.workspaceRoot}`,
            '--label',
            `tinyai.session=${request.sessionId}`,
            '--label',
            `tinyai.lease=${leaseId}`,
            this.image,
            'sh',
            '-lc',
            'trap "exit 0" TERM INT; while :; do sleep 3600; done',
          ],
          signal,
        },
        'CREATE_CONTAINER'
      );
    } catch (error) {
      if (volumeName) {
        await this.runDocker({ args: ['volume', 'rm', '-f', volumeName] }).catch(() => undefined);
      }
      throw error;
    }

    this.workspaces.set(leaseId, {
      lease,
      containerName,
      ...(volumeName ? { volumeName } : {}),
      ...(this.workspaceHostPath ? { bindWorkspacePath: this.workspaceHostPath } : {}),
      checkpoints: new Map(),
      idempotency: new Map(),
      released: false,
      ptys: new Set(),
    });
    return { ...lease };
  }

  async readFile(lease: WorkspaceLease, path: string, signal?: AbortSignal): Promise<SandboxFile> {
    const state = this.state(lease, signal);
    const absolutePath = this.path(state, path);
    const result = await this.expectSuccess(
      'DOCKER_FILE_READ_FAILED',
      {
        args: ['exec', state.containerName, 'base64', absolutePath],
        signal,
        timeoutMs: this.defaultTimeoutMs,
      },
      'READ_FILE'
    );
    return {
      path: absolutePath,
      data: base64ToBytes(result.stdout.replace(/\s+/g, '')),
      modifiedAt: this.now(),
    };
  }

  async writeFile(
    lease: WorkspaceLease,
    path: string,
    data: Uint8Array,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<SandboxFile> {
    const state = this.state(lease, options.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const absolutePath = this.path(state, path);
    const cacheKey = options.idempotencyKey ? `write:${options.idempotencyKey}` : undefined;
    const cached = cacheKey ? state.idempotency.get(cacheKey) : undefined;
    if (cached) return cloneFile(cached as SandboxFile);

    await this.expectSuccess(
      'DOCKER_FILE_WRITE_FAILED',
      {
        args: [
          'exec',
          '-i',
          state.containerName,
          'sh',
          '-lc',
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          'tinyai-write',
          absolutePath,
        ],
        stdin: new Uint8Array(data),
        signal: options.signal,
        timeoutMs: this.defaultTimeoutMs,
      },
      'WRITE_FILE'
    );
    const file: SandboxFile = {
      path: absolutePath,
      data: new Uint8Array(data),
      modifiedAt: this.now(),
    };
    if (cacheKey) state.idempotency.set(cacheKey, cloneFile(file));
    return cloneFile(file);
  }

  async listFiles(
    lease: WorkspaceLease,
    path = '.',
    signal?: AbortSignal
  ): Promise<SandboxFile[]> {
    const state = this.state(lease, signal);
    const absolutePath = path === '.' ? this.workspaceRoot : this.path(state, path);
    const result = await this.expectSuccess(
      'DOCKER_FILE_LIST_FAILED',
      {
        args: ['exec', state.containerName, 'find', absolutePath, '-type', 'f', '-print'],
        signal,
        timeoutMs: this.defaultTimeoutMs,
      },
      'LIST_FILES'
    );
    const files: SandboxFile[] = [];
    for (const line of result.stdout.split(/\r?\n/)) {
      const candidate = line.trim();
      if (candidate) files.push(await this.readFile(lease, this.relative(state, candidate), signal));
    }
    return files;
  }

  async deleteFile(
    lease: WorkspaceLease,
    path: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const state = this.state(lease, options.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const absolutePath = this.path(state, path);
    const cacheKey = options.idempotencyKey ? `delete:${options.idempotencyKey}` : undefined;
    if (cacheKey && state.idempotency.has(cacheKey)) {
      return state.idempotency.get(cacheKey) as boolean;
    }
    const result = await this.runDocker({
      args: ['exec', state.containerName, 'rm', '-f', '--', absolutePath],
      signal: options.signal,
      timeoutMs: this.defaultTimeoutMs,
    });
    const deleted = result.exitCode === 0;
    if (cacheKey) state.idempotency.set(cacheKey, deleted);
    return deleted;
  }

  async exec(lease: WorkspaceLease, request: ExecRequest): Promise<ExecResult> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) {
      throw new AgentError('SANDBOX_READ_ONLY', 'Read-only workspaces cannot execute commands');
    }
    const cacheKey = request.idempotencyKey ? `exec:${request.idempotencyKey}` : undefined;
    if (cacheKey && state.idempotency.has(cacheKey)) {
      return structuredClone(state.idempotency.get(cacheKey) as ExecResult);
    }
    const cwd =
      request.cwd && request.cwd !== '.'
        ? this.path(state, request.cwd)
        : this.workspaceRoot;
    const result = await this.runDocker({
      args: [
        'exec',
        '--workdir',
        cwd,
        state.containerName,
        request.command,
        ...(request.args ?? []),
      ],
      signal: request.signal,
      timeoutMs: request.timeoutMs ?? this.defaultTimeoutMs,
    });
    const normalized: ExecResult = {
      exitCode: result.exitCode,
      stdout: truncateText(result.stdout, this.maxOutputBytes),
      stderr: truncateText(result.stderr, this.maxOutputBytes),
      durationMs: result.durationMs,
      stdoutTruncated: result.stdoutTruncated === true ||
        new TextEncoder().encode(result.stdout).byteLength > this.maxOutputBytes,
      stderrTruncated: result.stderrTruncated === true ||
        new TextEncoder().encode(result.stderr).byteLength > this.maxOutputBytes,
    };
    if (cacheKey) state.idempotency.set(cacheKey, structuredClone(normalized));
    return normalized;
  }

  async checkpoint(lease: WorkspaceLease, signal?: AbortSignal): Promise<SandboxCheckpoint> {
    const state = this.state(lease, signal);
    const files = await this.listFiles(lease, '.', signal);
    const checkpointId = this.ids.next('docker_checkpoint');
    const metadata: SandboxCheckpoint = {
      checkpointId,
      files: files.map(cloneFile),
      createdAt: this.now(),
    };
    state.checkpoints.set(checkpointId, {
      metadata: {
        ...metadata,
        files: metadata.files.map(cloneFile),
      },
      files: new Map(files.map((file) => [this.relative(state, file.path), cloneFile(file)])),
    });
    return structuredClone(metadata);
  }

  async restore(
    lease: WorkspaceLease,
    checkpointId: string,
    signal?: AbortSignal
  ): Promise<void> {
    const state = this.state(lease, signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const checkpoint = state.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new AgentError(
        'SANDBOX_CHECKPOINT_NOT_FOUND',
        `Checkpoint not found: ${checkpointId}`
      );
    }
    await this.expectSuccess(
      'DOCKER_CHECKPOINT_RESTORE_FAILED',
      {
        args: [
          'exec',
          state.containerName,
          'find',
          this.workspaceRoot,
          '-mindepth',
          '1',
          '-delete',
        ],
        signal,
        timeoutMs: this.defaultTimeoutMs,
      },
      'CLEAR_WORKSPACE'
    );
    for (const [path, file] of checkpoint.files) {
      await this.writeFile(lease, path, file.data, { signal });
    }
    state.idempotency.clear();
  }

  async release(lease: WorkspaceLease): Promise<void> {
    const state = this.workspaces.get(lease.leaseId);
    if (!state) return;
    this.assertLease(state, lease, false);
    if (state.released) return;
    await Promise.all([...state.ptys].map((pty) => pty.close()));

    const errors: unknown[] = [];
    const stopped = await this.runDocker({
      args: ['rm', '-f', state.containerName],
      timeoutMs: this.defaultTimeoutMs,
    }).catch((error) => {
      errors.push(error);
      return undefined;
    });
    if (stopped && stopped.exitCode !== 0 && !/no such container/i.test(stopped.stderr)) {
      errors.push(new Error(stopped.stderr || resultMessage(stopped, 'container removal failed')));
    }
    if (state.volumeName) {
      const removed = await this.runDocker({
        args: ['volume', 'rm', '-f', state.volumeName],
        timeoutMs: this.defaultTimeoutMs,
      }).catch((error) => {
        errors.push(error);
        return undefined;
      });
      if (removed && removed.exitCode !== 0 && !/no such volume/i.test(removed.stderr)) {
        errors.push(new Error(removed.stderr || resultMessage(removed, 'volume removal failed')));
      }
    }
    if (errors.length) {
      throw new AgentError(
        'DOCKER_RELEASE_FAILED',
        errors.map((error) => (error instanceof Error ? error.message : String(error))).join('; ')
      );
    }
    state.released = true;
    state.idempotency.clear();
    state.checkpoints.clear();
    this.workspaces.delete(lease.leaseId);
  }

  async openPty(lease: WorkspaceLease, request: PtyOpenRequest): Promise<PtySession> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) {
      throw new AgentError('SANDBOX_READ_ONLY', 'Read-only workspaces cannot open a PTY');
    }
    if (!this.ptyRunner) {
      throw new AgentError('DOCKER_PTY_UNSUPPORTED', 'No Docker PTY runner was configured');
    }
    const cwd =
      request.cwd && request.cwd !== '.'
        ? this.path(state, request.cwd)
        : this.workspaceRoot;
    const command = [request.command, ...(request.args ?? [])].map(shellQuote).join(' ');
    const process = await this.ptyRunner.open({
      args: [
        'exec',
        '-i',
        '--workdir',
        cwd,
        state.containerName,
        'script',
        '-q',
        '-c',
        command,
        '/dev/null',
      ],
      signal: request.signal,
    });
    const pty = new DockerPtySession(this.ids.next('docker_pty'), process, () => {
      state.ptys.delete(pty);
    });
    state.ptys.add(pty);
    return pty;
  }

  async dispose(): Promise<void> {
    const leases = [...this.workspaces.values()].map((state) => ({ ...state.lease }));
    const results = await Promise.allSettled(leases.map((lease) => this.release(lease)));
    this.workspaces.clear();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected) throw rejected.reason;
  }

  private state(lease: WorkspaceLease, signal?: AbortSignal): WorkspaceState {
    assertActive(signal);
    const state = this.workspaces.get(lease.leaseId);
    if (!state) throw new AgentError('SANDBOX_RELEASED', `Workspace lease is not active: ${lease.leaseId}`);
    this.assertLease(state, lease);
    return state;
  }

  private assertLease(
    state: WorkspaceState,
    lease: WorkspaceLease,
    checkExpiry = true
  ): void {
    if (state.released) {
      throw new AgentError('SANDBOX_RELEASED', `Workspace lease is released: ${lease.leaseId}`);
    }
    if (
      state.lease.fencingToken !== lease.fencingToken ||
      state.lease.sessionId !== lease.sessionId
    ) {
      throw new AgentError('SANDBOX_LEASE_INVALID', `Workspace lease is stale: ${lease.leaseId}`);
    }
    if (checkExpiry && state.lease.expiresAt <= this.now()) {
      throw new AgentError('SANDBOX_LEASE_EXPIRED', `Workspace lease expired: ${lease.leaseId}`);
    }
  }

  private path(state: WorkspaceState, input: string): string {
    const relative = normalizeRelative(input);
    const absolute = joinContainerPath(this.workspaceRoot, relative);
    this.relative(state, absolute);
    return absolute;
  }

  private relative(_state: WorkspaceState, absolute: string): string {
    const normalized = normalizeContainerRoot(absolute);
    if (normalized === this.workspaceRoot) return '.';
    const prefix = `${this.workspaceRoot}/`;
    if (!normalized.startsWith(prefix)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Path escapes workspace: ${absolute}`);
    }
    return normalized.slice(prefix.length);
  }

  private async expectSuccess(
    code: string,
    request: DockerCommandRequest,
    operation: string
  ): Promise<DockerCommandResult> {
    const result = await this.runDocker(request);
    if (result.exitCode !== 0) {
      throw new AgentError(
        code,
        result.stderr.trim() || resultMessage(result, `${operation} failed`),
        {
          details: {
            operation,
            exitCode: result.exitCode,
          },
        }
      );
    }
    return result;
  }

  private runDocker(request: DockerCommandRequest): Promise<DockerCommandResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    if (request.signal?.aborted) controller.abort();
    const timeoutMs = request.timeoutMs ?? this.defaultTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentError('DOCKER_COMMAND_TIMEOUT', `Docker command timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return Promise.race([
      this.runner.run({ ...request, signal: controller.signal }),
      timeout,
    ]).finally(() => {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
    });
  }
}

class DockerPtySession implements PtySession {
  readonly id: string;
  private readonly events: PtyEvent[] = [];
  private readonly waiters = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private closed = false;

  constructor(
    id: string,
    private readonly process: DockerPtyProcess,
    private readonly onClose: () => void
  ) {
    this.id = id;
    this.unsubscribe = process.onEvent((event) => {
      this.events.push(event);
      for (const wake of this.waiters) wake();
    });
  }

  async write(data: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen(signal);
    await this.process.write(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.assertOpen();
    await this.process.resize(cols, rows);
  }

  async read(timeoutMs = 0, signal?: AbortSignal): Promise<PtyEvent[]> {
    this.assertOpen(signal);
    if (this.events.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    return this.events.splice(0);
  }

  onEvent(listener: (event: PtyEvent) => void): () => void {
    return this.process.onEvent(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    await this.process.close();
    this.onClose();
  }

  private assertOpen(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'PTY operation cancelled');
    if (this.closed) throw new AgentError('PTY_CLOSED', `PTY is closed: ${this.id}`);
  }
}

function normalizeContainerRoot(path: string): string {
  if (!path.startsWith('/')) {
    throw new AgentError('DOCKER_WORKSPACE_ROOT_INVALID', `Workspace root must be absolute: ${path}`);
  }
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '..')) {
    throw new AgentError('DOCKER_WORKSPACE_ROOT_INVALID', `Workspace root escapes container root: ${path}`);
  }
  return `/${parts.join('/')}`;
}

function normalizeRelative(path: string): string {
  if (path.startsWith('/')) {
    throw new AgentError('SANDBOX_PATH_ESCAPE', `Absolute paths are not allowed: ${path}`);
  }
  const normalized = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const parts = normalized.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.some((part) => part === '..')) {
    throw new AgentError('SANDBOX_PATH_ESCAPE', `Invalid workspace path: ${path}`);
  }
  return parts.join('/');
}

function joinContainerPath(root: string, path: string): string {
  return `${root.replace(/\/+$/, '')}/${path}`;
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48);
}

function truncateText(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maxBytes) return value;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function resultMessage(result: DockerCommandResult, fallback: string): string {
  return result.stdout.trim() || fallback;
}

function cloneFile(file: SandboxFile): SandboxFile {
  return {
    ...file,
    data: new Uint8Array(file.data),
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'Sandbox operation was cancelled');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
