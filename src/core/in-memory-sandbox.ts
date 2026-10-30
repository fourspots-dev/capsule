import { AgentError } from './errors';
import type {
  ExecRequest,
  ExecResult,
  SandboxCheckpoint,
  SandboxFile,
  SandboxProvider,
  PtyEvent,
  PtyOpenRequest,
  PtySession,
  WorkspaceLease,
} from './sandbox-provider';

interface WorkspaceState {
  files: Map<string, SandboxFile>;
  checkpoints: Map<string, SandboxCheckpoint>;
  released: boolean;
  networking: Set<string>;
  idempotency: Map<string, unknown>;
  ptys: Set<InMemoryPty>;
}

export interface InMemorySandboxOptions {
  now?: () => number;
  ids?: { next(prefix: string): string };
  exec?: (request: ExecRequest, state: WorkspaceState) => Promise<ExecResult>;
  allowNetwork?: boolean;
}

export class InMemorySandbox implements SandboxProvider {
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly leases = new Map<string, WorkspaceLease>();
  private readonly now: () => number;
  private readonly ids: { next(prefix: string): string };
  private readonly execImpl: (request: ExecRequest, state: WorkspaceState) => Promise<ExecResult>;
  private readonly networkAllowed: boolean;
  private sequence = 0;

  constructor(options: InMemorySandboxOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.ids =
      options.ids ?? {
        next: (prefix) => `${prefix}_${++this.sequence}`,
      };
    this.networkAllowed = options.allowNetwork ?? false;
    this.execImpl =
      options.exec ??
      (async (request) => ({
        exitCode: 0,
        stdout: `${request.command} ${request.args?.join(' ') ?? ''}`.trim(),
        stderr: '',
        durationMs: 0,
        stdoutTruncated: false,
        stderrTruncated: false,
      }));
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
    const lease: WorkspaceLease = {
      leaseId: this.ids.next('lease'),
      sessionId: request.sessionId,
      workspaceRoot: normalizeAbsolutePath(request.workspaceRoot ?? '/workspace'),
      fencingToken: 1,
      createdAt: this.now(),
      expiresAt: this.now() + (request.ttlMs ?? 3_600_000),
      readOnly: request.readOnly ?? false,
    };
    this.workspaces.set(lease.leaseId, {
      files: new Map(),
      checkpoints: new Map(),
      released: false,
      networking: new Set(),
      idempotency: new Map(),
      ptys: new Set(),
    });
    this.leases.set(lease.leaseId, lease);
    return { ...lease };
  }

  async readFile(lease: WorkspaceLease, path: string, signal?: AbortSignal): Promise<SandboxFile> {
    const state = this.state(lease, signal);
    const file = state.files.get(this.fileKey(lease, path));
    if (!file) throw new AgentError('SANDBOX_FILE_NOT_FOUND', `File not found: ${path}`);
    return cloneFile(file);
  }

  async writeFile(
    lease: WorkspaceLease,
    path: string,
    data: Uint8Array,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<SandboxFile> {
    const state = this.state(lease, options.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const idempotencyKey = options.idempotencyKey ? `write:${options.idempotencyKey}` : undefined;
    const cached = idempotencyKey ? state.idempotency.get(idempotencyKey) : undefined;
    if (cached) return cloneFile(cached as SandboxFile);
    const key = this.fileKey(lease, path);
    const file: SandboxFile = {
      path: key,
      data: new Uint8Array(data),
      modifiedAt: this.now(),
    };
    state.files.set(key, file);
    if (idempotencyKey) state.idempotency.set(idempotencyKey, cloneFile(file));
    return cloneFile(file);
  }

  async listFiles(lease: WorkspaceLease, path = '.', signal?: AbortSignal): Promise<SandboxFile[]> {
    const state = this.state(lease, signal);
    const prefix = path === '.' ? `${lease.workspaceRoot}/` : `${this.fileKey(lease, path)}/`;
    return [...state.files.values()]
      .filter((file) => file.path.startsWith(prefix))
      .map(cloneFile);
  }

  async deleteFile(
    lease: WorkspaceLease,
    path: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const state = this.state(lease, options.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const idempotencyKey = options.idempotencyKey ? `delete:${options.idempotencyKey}` : undefined;
    if (idempotencyKey && state.idempotency.has(idempotencyKey)) {
      return state.idempotency.get(idempotencyKey) as boolean;
    }
    const removed = state.files.delete(this.fileKey(lease, path));
    if (idempotencyKey) state.idempotency.set(idempotencyKey, removed);
    return removed;
  }

  async exec(lease: WorkspaceLease, request: ExecRequest): Promise<ExecResult> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) {
      throw new AgentError('SANDBOX_READ_ONLY', 'Read-only workspaces cannot execute commands');
    }
    const idempotencyKey = request.idempotencyKey ? `exec:${request.idempotencyKey}` : undefined;
    if (idempotencyKey && state.idempotency.has(idempotencyKey)) {
      return structuredClone(state.idempotency.get(idempotencyKey) as ExecResult);
    }
    const timeoutMs = request.timeoutMs ?? 120_000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        this.execImpl({ ...request, signal: controller.signal }, state),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new AgentError('SANDBOX_EXEC_TIMEOUT', `Command timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        }),
      ]);
      if (idempotencyKey) state.idempotency.set(idempotencyKey, structuredClone(result));
      return structuredClone(result);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  async checkpoint(lease: WorkspaceLease, signal?: AbortSignal): Promise<SandboxCheckpoint> {
    const state = this.state(lease, signal);
    const checkpoint: SandboxCheckpoint = {
      checkpointId: this.ids.next('checkpoint'),
      files: [...state.files.values()].map(cloneFile),
      createdAt: this.now(),
    };
    state.checkpoints.set(checkpoint.checkpointId, {
      ...checkpoint,
      files: checkpoint.files.map(cloneFile),
    });
    return structuredClone(checkpoint);
  }

  async restore(lease: WorkspaceLease, checkpointId: string, signal?: AbortSignal): Promise<void> {
    const state = this.state(lease, signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const checkpoint = state.checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new AgentError('SANDBOX_CHECKPOINT_NOT_FOUND', `Checkpoint not found: ${checkpointId}`);
    }
    state.files = new Map(checkpoint.files.map((file) => [file.path, cloneFile(file)]));
    state.idempotency.clear();
  }

  async release(lease: WorkspaceLease): Promise<void> {
    const state = this.state(lease);
    await Promise.all([...state.ptys].map((pty) => pty.close()));
    state.released = true;
    state.files.clear();
    state.checkpoints.clear();
    state.idempotency.clear();
    this.workspaces.delete(lease.leaseId);
    this.leases.delete(lease.leaseId);
  }

  async openPty(lease: WorkspaceLease, request: PtyOpenRequest): Promise<PtySession> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) {
      throw new AgentError('SANDBOX_READ_ONLY', 'Read-only workspaces cannot open a PTY');
    }
    const pty = new InMemoryPty(
      this.ids.next('pty'),
      request.command,
      request.args ?? [],
      () => {
        state.ptys.delete(pty);
      }
    );
    state.ptys.add(pty);
    return pty;
  }

  allowNetwork(lease: WorkspaceLease, host: string, allowed = true): void {
    const state = this.state(lease);
    if (allowed && !this.networkAllowed) {
      throw new AgentError('SANDBOX_NETWORK_DENIED', 'Sandbox provider network access is disabled');
    }
    if (allowed) state.networking.add(host);
    else state.networking.delete(host);
  }

  private state(lease: WorkspaceLease, signal?: AbortSignal): WorkspaceState {
    assertActive(signal);
    const current = this.leases.get(lease.leaseId);
    if (!current || current.fencingToken !== lease.fencingToken) {
      throw new AgentError('SANDBOX_LEASE_INVALID', `Workspace lease is stale: ${lease.leaseId}`);
    }
    if (current.expiresAt <= this.now()) {
      throw new AgentError('SANDBOX_LEASE_EXPIRED', `Workspace lease expired: ${lease.leaseId}`);
    }
    const state = this.workspaces.get(lease.leaseId);
    if (!state || state.released) {
      throw new AgentError('SANDBOX_RELEASED', `Workspace lease was released: ${lease.leaseId}`);
    }
    return state;
  }

  private fileKey(lease: WorkspaceLease, path: string): string {
    const normalized = normalizeRelativePath(path);
    const full = normalizeAbsolutePath(`${lease.workspaceRoot}/${normalized}`);
    if (full !== lease.workspaceRoot && !full.startsWith(`${lease.workspaceRoot}/`)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Path escapes workspace: ${path}`);
    }
    return full;
  }
}

class InMemoryPty implements PtySession {
  readonly id: string;
  private readonly events: PtyEvent[] = [];
  private readonly listeners = new Set<(event: PtyEvent) => void>();
  private waiters: Array<() => void> = [];
  private closed = false;
  private readonly command: string;
  private readonly args: string[];
  private readonly onClose: () => void;

  constructor(
    id: string,
    command: string,
    args: string[],
    onClose: () => void
  ) {
    this.id = id;
    this.command = command;
    this.args = args;
    this.onClose = onClose;
    this.push({
      type: 'data',
      stream: 'stdout',
      data: `$ ${command}${args.length ? ` ${args.join(' ')}` : ''}\r\n`,
    });
  }

  async write(data: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen(signal);
    const command = data.replace(/\r?\n$/, '');
    this.push({ type: 'data', stream: 'stdout', data: `${command}\r\n` });
    if (/^(exit|logout)$/.test(command.trim())) {
      this.push({ type: 'exit', exitCode: 0 });
      await this.close();
    }
  }

  async resize(_cols: number, _rows: number): Promise<void> {
    this.assertOpen();
  }

  async read(timeoutMs = 0, signal?: AbortSignal): Promise<PtyEvent[]> {
    this.assertOpen(signal);
    if (this.events.length === 0 && timeoutMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        this.waiters.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    return this.events.splice(0);
  }

  onEvent(listener: (event: PtyEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
    this.listeners.clear();
    this.onClose();
  }

  private push(event: PtyEvent): void {
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    for (const wake of this.waiters.splice(0)) wake();
  }

  private assertOpen(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'PTY operation cancelled');
    if (this.closed) throw new AgentError('PTY_CLOSED', `PTY is closed: ${this.id}`);
  }
}

function normalizeAbsolutePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Path escapes workspace: ${path}`);
    }
    parts.push(part);
  }
  return `/${parts.join('/')}`;
}

function normalizeRelativePath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '..')) {
    throw new AgentError('SANDBOX_PATH_ESCAPE', `Invalid workspace path: ${path}`);
  }
  return normalized;
}

function cloneFile(file: SandboxFile): SandboxFile {
  return { ...file, data: new Uint8Array(file.data) };
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'Sandbox operation was cancelled');
}
