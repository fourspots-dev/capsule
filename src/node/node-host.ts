import { spawn } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import type {
  HostBridge,
  HostCapability,
  HostClock,
  HostCrypto,
  HostProcessBridge,
  HostProcessRequest,
  HostProcessResult,
  HostStorage,
  HostTerminal,
  HostWorkspaceBridge,
} from '../host';
import {
  createWorkspaceBundle,
  serializeWorkspaceBundle,
  WORKSPACE_BUNDLE_FORMAT,
  WORKSPACE_BUNDLE_SCHEMA_VERSION,
} from '../virtual';

export interface NodeTerminalStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  error?: NodeJS.WriteStream;
}

export interface NodeHostOptions {
  id?: string;
  projectRoot?: string;
  stateRoot?: string;
  terminal?: NodeTerminalStreams;
  process?: boolean;
  now?: () => number;
}

const skippedDirectories = new Set(['.git', 'node_modules', '.tinyai']);

export class NodeHostBridge implements HostBridge {
  readonly descriptor;
  readonly storage: NodeHostStorage;
  readonly clock: HostClock;
  readonly scheduler: NonNullable<HostBridge['scheduler']>;
  readonly crypto: HostCrypto;
  readonly clone: NonNullable<HostBridge['clone']>;
  readonly workspace: HostWorkspaceBridge;
  readonly terminal?: NodeTerminal;
  readonly process?: HostProcessBridge;

  constructor(private readonly options: NodeHostOptions) {
    const stateRoot = options.stateRoot ?? join(options.projectRoot ?? process.cwd(), '.tinyai');
    this.storage = new NodeHostStorage(join(stateRoot, 'host-storage.json'));
    this.clock = nodeClock(options.now);
    this.scheduler = {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      queueMicrotask: (callback) => queueMicrotask(callback),
    };
    this.crypto = nodeCrypto;
    this.clone = { clone: <T>(value: T): T => structuredClone(value) };
    this.workspace = {
      importWorkspace: options.projectRoot
        ? async () => serializeWorkspaceBundle(await importDirectory(options.projectRoot!))
        : undefined,
      exportWorkspace: async (data) => {
        const target = join(stateRoot, 'exports', `workspace-${Date.now()}.json`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, data);
      },
    };
    this.terminal = options.terminal ? new NodeTerminal(options.terminal) : undefined;
    this.process = options.process
      ? new NodeProcessBridge(options.projectRoot ?? process.cwd())
      : undefined;
    const capabilities: HostCapability[] = [
      ...(options.projectRoot
        ? (['workspace.import', 'workspace.export'] as const)
        : (['workspace.export'] as const)),
      'storage',
      'clock',
      'scheduler',
      'crypto',
      'clone',
      ...(this.terminal ? (['terminal'] as const) : []),
      ...(this.process ? (['process'] as const) : []),
    ];
    this.descriptor = {
      id: options.id ?? 'node-host',
      platform: process.platform,
      capabilities,
    };
  }
}

export class NodeHostStorage implements HostStorage {
  private loaded?: Promise<Record<string, unknown>>;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async get(key: string): Promise<unknown> {
    return structuredClone((await this.load())[key]);
  }

  async set(key: string, value: unknown): Promise<void> {
    const values = await this.load();
    values[key] = structuredClone(value);
    await this.persist(values);
  }

  async remove(key: string): Promise<void> {
    const values = await this.load();
    delete values[key];
    await this.persist(values);
  }

  async list(prefix = ''): Promise<string[]> {
    return Object.keys(await this.load())
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  private load(): Promise<Record<string, unknown>> {
    this.loaded ??= (async () => {
      try {
        const raw = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
        return raw && typeof raw === 'object' && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
        throw error;
      }
    })();
    return this.loaded;
  }

  private persist(values: Record<string, unknown>): Promise<void> {
    const snapshot = structuredClone(values);
    const operation = this.writeTail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = `${this.path}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(snapshot));
      await rename(temporary, this.path);
    });
    this.writeTail = operation.catch(() => undefined);
    return operation;
  }
}

export class NodeTerminal implements HostTerminal {
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<
    (size: { columns: number; rows: number }) => void
  >();
  private started = false;
  private readonly onData = (data: Buffer | string) => {
    for (const listener of this.inputListeners) listener(data.toString());
  };
  private readonly handleResize = () => {
    for (const listener of this.resizeListeners) listener(this.size());
  };

  constructor(private readonly streams: NodeTerminalStreams) {}

  write(data: string): void {
    this.streams.output.write(data);
  }

  onInput(listener: (data: string) => void): () => void {
    this.inputListeners.add(listener);
    return () => this.inputListeners.delete(listener);
  }

  onResize(
    listener: (size: { columns: number; rows: number }) => void
  ): () => void {
    this.resizeListeners.add(listener);
    return () => this.resizeListeners.delete(listener);
  }

  size(): { columns: number; rows: number } {
    return {
      columns: this.streams.output.columns || 80,
      rows: this.streams.output.rows || 24,
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.streams.input.setRawMode?.(true);
    this.streams.input.resume();
    this.streams.input.on('data', this.onData);
    this.streams.output.on('resize', this.handleResize);
    this.streams.output.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.streams.input.off('data', this.onData);
    this.streams.output.off('resize', this.handleResize);
    this.streams.input.setRawMode?.(false);
    this.streams.input.pause();
    this.streams.output.write('\x1b[0 q\x1b[?25h\x1b[?1049l');
  }
}

class NodeProcessBridge implements HostProcessBridge {
  constructor(private readonly workspaceRoot: string) {}

  execute(request: HostProcessRequest): Promise<HostProcessResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd ?? this.workspaceRoot,
        env: { ...process.env, ...request.env },
        signal: request.signal,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout: new Uint8Array(Buffer.concat(stdout)),
          stderr: new Uint8Array(Buffer.concat(stderr)),
        });
      });
      if (request.stdin) child.stdin.end(Buffer.from(request.stdin));
      else child.stdin.end();
    });
  }
}

async function importDirectory(root: string) {
  const files: Array<{ path: string; dataBase64: string; mode?: number }> = [];
  const directories: string[] = [];
  await collectDirectory(root, root, files, directories);
  return createWorkspaceBundle({ files, directories });
}

async function collectDirectory(
  root: string,
  current: string,
  files: Array<{ path: string; dataBase64: string; mode?: number }>,
  directories: string[]
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (skippedDirectories.has(entry.name)) continue;
      directories.push(path);
      await collectDirectory(root, absolute, files, directories);
    } else if (entry.isFile()) {
      files.push({
        path,
        dataBase64: (await readFile(absolute)).toString('base64'),
      });
    }
  }
}

function nodeClock(now: () => number = () => Date.now()): HostClock {
  return {
    now,
    setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
    clearTimeout: (handle) =>
      clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
}

const nodeCrypto: HostCrypto = {
  async digest(algorithm, data) {
    if (algorithm !== 'SHA-256') throw new Error(`Unsupported digest: ${algorithm}`);
    const result = await globalThis.crypto.subtle.digest(
      algorithm,
      data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    );
    return new Uint8Array(result);
  },
  randomBytes(length) {
    const result = new Uint8Array(length);
    globalThis.crypto.getRandomValues(result);
    return result;
  },
};
