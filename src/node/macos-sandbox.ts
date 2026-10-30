import { spawn } from 'node:child_process';
import { constants, realpath, readdir } from 'node:fs/promises';
import {
  access,
  mkdir,
  mkdtemp,
  readFile as readHostFile,
  rm,
  unlink,
  writeFile as writeHostFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
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

interface MacWorkspaceState {
  lease: WorkspaceLease;
  root: string;
  owned: boolean;
  released: boolean;
  checkpoints: Map<string, SandboxCheckpoint>;
  idempotency: Map<string, unknown>;
  ptys: Set<MacPtySession>;
}

export interface MacOSSandboxOptions {
  sandboxExec?: string;
  now?: () => number;
  ids?: { next(prefix: string): string };
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  allowNetwork?: boolean;
}

export class MacOSSeatbeltSandbox implements SandboxProvider {
  private readonly sandboxExec: string;
  private readonly now: () => number;
  private readonly ids: { next(prefix: string): string };
  private readonly defaultTimeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly allowNetwork: boolean;
  private readonly workspaces = new Map<string, MacWorkspaceState>();

  constructor(options: MacOSSandboxOptions = {}) {
    this.sandboxExec = options.sandboxExec ?? '/usr/bin/sandbox-exec';
    this.now = options.now ?? (() => Date.now());
    let sequence = 0;
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${++sequence}` };
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 120_000;
    this.maxOutputBytes = options.maxOutputBytes ?? 1_000_000;
    this.allowNetwork = options.allowNetwork ?? false;
  }

  async createWorkspace(request: {
    sessionId: string;
    workspaceRoot?: string;
    readOnly?: boolean;
    ttlMs?: number;
    budget?: Record<string, number>;
  }): Promise<WorkspaceLease> {
    const owned = !request.workspaceRoot;
    const root = owned
      ? await realpath(await mkdtemp(join(tmpdir(), 'tinyai-seatbelt-')))
      : await realpath(resolve(request.workspaceRoot!));
    await mkdir(join(root, '.tinyai-tmp'), { recursive: true });
    await mkdir(join(root, '.tinyai-home'), { recursive: true });
    const lease: WorkspaceLease = {
      leaseId: this.ids.next('seatbelt_lease'),
      sessionId: request.sessionId,
      workspaceRoot: root,
      fencingToken: 1,
      createdAt: this.now(),
      expiresAt: this.now() + (request.ttlMs ?? 3_600_000),
      readOnly: request.readOnly ?? false,
    };
    this.workspaces.set(lease.leaseId, {
      lease,
      root,
      owned,
      released: false,
      checkpoints: new Map(),
      idempotency: new Map(),
      ptys: new Set(),
    });
    return { ...lease };
  }

  async readFile(lease: WorkspaceLease, path: string): Promise<SandboxFile> {
    const state = this.state(lease);
    const absolute = await this.existingPath(state, path);
    const stat = await access(absolute, constants.R_OK).then(() => true);
    if (!stat) throw new AgentError('SANDBOX_FILE_NOT_FOUND', `File not found: ${path}`);
    return {
      path: relative(state.root, absolute),
      data: new Uint8Array(await readHostFile(absolute)),
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
    const absolute = this.safePath(state, path);
    await mkdir(dirname(absolute), { recursive: true });
    await this.assertRealParent(state, absolute);
    const cacheKey = options.idempotencyKey ? `write:${options.idempotencyKey}` : undefined;
    const cached = cacheKey ? state.idempotency.get(cacheKey) : undefined;
    if (cached) return cloneFile(cached as SandboxFile);
    await writeHostFile(absolute, data);
    const file = {
      path: relative(state.root, absolute),
      data: new Uint8Array(data),
      modifiedAt: this.now(),
    };
    if (cacheKey) state.idempotency.set(cacheKey, cloneFile(file));
    return cloneFile(file);
  }

  async listFiles(lease: WorkspaceLease, path = '.', signal?: AbortSignal): Promise<SandboxFile[]> {
    const state = this.state(lease, signal);
    const root = path === '.' ? state.root : await this.existingPath(state, path);
    const files: SandboxFile[] = [];
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith('.tinyai-')) continue;
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) {
          files.push({
            path: relative(state.root, absolute),
            data: new Uint8Array(await readHostFile(absolute)),
            modifiedAt: this.now(),
          });
        }
      }
    };
    await walk(root);
    return files;
  }

  async deleteFile(
    lease: WorkspaceLease,
    path: string,
    options: { idempotencyKey?: string; signal?: AbortSignal } = {}
  ): Promise<boolean> {
    const state = this.state(lease, options.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const absolute = this.safePath(state, path);
    const cacheKey = options.idempotencyKey ? `delete:${options.idempotencyKey}` : undefined;
    if (cacheKey && state.idempotency.has(cacheKey)) return Boolean(state.idempotency.get(cacheKey));
    let deleted = false;
    try {
      await unlink(absolute);
      deleted = true;
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (cacheKey) state.idempotency.set(cacheKey, deleted);
    return deleted;
  }

  async exec(lease: WorkspaceLease, request: ExecRequest): Promise<ExecResult> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const cacheKey = request.idempotencyKey ? `exec:${request.idempotencyKey}` : undefined;
    if (cacheKey && state.idempotency.has(cacheKey)) {
      return structuredClone(state.idempotency.get(cacheKey) as ExecResult);
    }
    const cwd = request.cwd ? await this.existingPath(state, request.cwd) : state.root;
    if (!cwd.startsWith(state.root)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Working directory escapes workspace: ${cwd}`);
    }
    const profile = this.profile(state);
    const args = [
      '-p',
      profile,
      request.command,
      ...(request.args ?? []),
    ];
    const result = await runProcess(
      this.sandboxExec,
      args,
      cwd,
      {
        HOME: join(state.root, '.tinyai-home'),
        TMPDIR: join(state.root, '.tinyai-tmp'),
        PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
        LANG: process.env.LANG ?? 'en_US.UTF-8',
      },
      request.timeoutMs ?? this.defaultTimeoutMs,
      this.maxOutputBytes,
      request.signal
    );
    if (cacheKey) state.idempotency.set(cacheKey, structuredClone(result));
    return result;
  }

  async checkpoint(lease: WorkspaceLease): Promise<SandboxCheckpoint> {
    const state = this.state(lease);
    const checkpoint: SandboxCheckpoint = {
      checkpointId: this.ids.next('seatbelt_checkpoint'),
      files: await this.listFiles(lease),
      createdAt: this.now(),
    };
    state.checkpoints.set(checkpoint.checkpointId, structuredClone(checkpoint));
    return structuredClone(checkpoint);
  }

  async restore(lease: WorkspaceLease, checkpointId: string): Promise<void> {
    const state = this.state(lease);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const checkpoint = state.checkpoints.get(checkpointId);
    if (!checkpoint) throw new AgentError('SANDBOX_CHECKPOINT_NOT_FOUND', checkpointId);
    for (const entry of await readdir(state.root)) {
      if (!entry.startsWith('.tinyai-')) await rm(join(state.root, entry), { recursive: true, force: true });
    }
    for (const file of checkpoint.files) await this.writeFile(lease, file.path, file.data);
    state.idempotency.clear();
  }

  async release(lease: WorkspaceLease): Promise<void> {
    const state = this.workspaces.get(lease.leaseId);
    if (!state || state.released) return;
    await Promise.all([...state.ptys].map((pty) => pty.close()));
    state.released = true;
    this.workspaces.delete(lease.leaseId);
    if (state.owned) await rm(state.root, { recursive: true, force: true });
  }

  async openPty(lease: WorkspaceLease, request: PtyOpenRequest): Promise<PtySession> {
    const state = this.state(lease, request.signal);
    if (lease.readOnly) throw new AgentError('SANDBOX_READ_ONLY', 'Workspace is read-only');
    const cwd = request.cwd ? await this.existingPath(state, request.cwd) : state.root;
    const command = [request.command, ...(request.args ?? [])]
      .map(shellQuote)
      .join(' ');
    const child = spawn(
      this.sandboxExec,
      [
        '-p',
        this.profile(state),
        '/usr/bin/expect',
        '-c',
        'spawn /bin/sh -c $env(TINYAI_PTY_COMMAND); interact',
      ],
      {
        cwd,
        env: {
          HOME: join(state.root, '.tinyai-home'),
          TMPDIR: join(state.root, '.tinyai-tmp'),
          PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
          LANG: process.env.LANG ?? 'en_US.UTF-8',
          TINYAI_PTY_COMMAND: command,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
        signal: request.signal,
      }
    );
    const pty = new MacPtySession(this.ids.next('seatbelt_pty'), child, () => {
      state.ptys.delete(pty);
    });
    state.ptys.add(pty);
    return pty;
  }

  private profile(state: MacWorkspaceState): string {
    const writeRoot = escapeSeatbelt(state.root);
    const temp = escapeSeatbelt(join(state.root, '.tinyai-tmp'));
    const home = escapeSeatbelt(join(state.root, '.tinyai-home'));
    const deniedReads = [
      join(homedir(), '.ssh'),
      join(homedir(), '.aws'),
      join(homedir(), '.gnupg'),
      join(homedir(), 'Library/Keychains'),
    ]
      .map((path) => `(deny file-read* (subpath ${escapeSeatbelt(path)}))`)
      .join('\n');
    return [
      '(version 1)',
      '(allow default)',
      ...(this.allowNetwork ? [] : ['(deny network*)']),
      '(deny file-write*)',
      `(allow file-write* (subpath ${writeRoot}) (subpath ${temp}) (subpath ${home}) (subpath "/dev"))`,
      '(allow file-ioctl (subpath "/dev"))',
      deniedReads,
    ].join('\n');
  }

  private state(lease: WorkspaceLease, signal?: AbortSignal): MacWorkspaceState {
    if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'Sandbox operation cancelled');
    const state = this.workspaces.get(lease.leaseId);
    if (!state || state.released) {
      throw new AgentError('SANDBOX_RELEASED', `Workspace lease is not active: ${lease.leaseId}`);
    }
    if (state.lease.fencingToken !== lease.fencingToken || state.lease.sessionId !== lease.sessionId) {
      throw new AgentError('SANDBOX_LEASE_INVALID', `Workspace lease is stale: ${lease.leaseId}`);
    }
    if (state.lease.expiresAt <= this.now()) {
      throw new AgentError('SANDBOX_LEASE_EXPIRED', `Workspace lease expired: ${lease.leaseId}`);
    }
    return state;
  }

  private safePath(state: MacWorkspaceState, path: string): string {
    const absolute = resolve(state.root, path);
    if (absolute !== state.root && !absolute.startsWith(`${state.root}/`)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Path escapes workspace: ${path}`);
    }
    if (['.tinyai-tmp', '.tinyai-home', '.tinyai'].includes(relative(state.root, absolute))) {
      throw new AgentError('SANDBOX_PATH_RESERVED', `Path is reserved: ${path}`);
    }
    return absolute;
  }

  private async existingPath(state: MacWorkspaceState, path: string): Promise<string> {
    const absolute = this.safePath(state, path);
    const resolved = await realpath(absolute);
    if (resolved !== state.root && !resolved.startsWith(`${state.root}/`)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Symlink escapes workspace: ${path}`);
    }
    return resolved;
  }

  private async assertRealParent(state: MacWorkspaceState, absolute: string): Promise<void> {
    const parent = await realpath(dirname(absolute));
    if (parent !== state.root && !parent.startsWith(`${state.root}/`)) {
      throw new AgentError('SANDBOX_PATH_ESCAPE', `Parent escapes workspace: ${absolute}`);
    }
  }
}

class MacPtySession implements PtySession {
  readonly id: string;
  private readonly events: PtyEvent[] = [];
  private readonly listeners = new Set<(event: PtyEvent) => void>();
  private readonly waiters = new Set<() => void>();
  private closed = false;

  constructor(
    id: string,
    private readonly child: ReturnType<typeof spawn>,
    private readonly onClose: () => void
  ) {
    this.id = id;
    child.stdout?.on('data', (data: Buffer) =>
      this.push({ type: 'data', stream: 'stdout', data: data.toString('utf8') })
    );
    child.stderr?.on('data', (data: Buffer) =>
      this.push({ type: 'data', stream: 'stderr', data: data.toString('utf8') })
    );
    child.on('close', (code) => this.push({ type: 'exit', exitCode: code ?? 1 }));
  }

  async write(data: string, signal?: AbortSignal): Promise<void> {
    this.assertOpen(signal);
    this.child.stdin?.write(data);
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
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.child.kill('SIGTERM');
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    this.listeners.clear();
    this.onClose();
  }

  private push(event: PtyEvent): void {
    if (this.closed && event.type !== 'exit') return;
    this.events.push(event);
    for (const listener of this.listeners) listener(event);
    for (const wake of this.waiters) wake();
  }

  private assertOpen(signal?: AbortSignal): void {
    if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'PTY operation cancelled');
    if (this.closed) throw new AgentError('PTY_CLOSED', `PTY is closed: ${this.id}`);
  }
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
  maxOutputBytes: number,
  signal?: AbortSignal
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], signal });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTruncated = false;
    let stderrTruncated = false;
    const collect = (target: Buffer[], truncated: { value: boolean }, chunk: Buffer, current: number) => {
      if (current >= maxOutputBytes) {
        truncated.value = true;
        return current;
      }
      const kept = chunk.subarray(0, maxOutputBytes - current);
      target.push(kept);
      truncated.value ||= kept.byteLength < chunk.byteLength;
      return current + kept.byteLength;
    };
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes = collect(stdout, { get value() { return stdoutTruncated; }, set value(value) { stdoutTruncated = value; } }, chunk, stdoutBytes);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes = collect(stderr, { get value() { return stderrTruncated; }, set value(value) { stderrTruncated = value; } }, chunk, stderrBytes);
    });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError('SANDBOX_EXEC_TIMEOUT', `Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Date.now() - started,
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

function escapeSeatbelt(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function cloneFile(file: SandboxFile): SandboxFile {
  return { ...file, data: new Uint8Array(file.data) };
}
