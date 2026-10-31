import { AgentError } from '../core/errors';
import {
  assertHostCapabilities,
  hasHostCapability,
  MemoryHostBridge,
  type HostBridge,
  type HostCapability,
} from '../host';
import {
  ArchiveFileSystem,
  cloneBundle,
  parseWorkspaceBundle,
  serializeWorkspaceBundle,
  type WorkspaceBundle,
  type WorkspaceBundleFile,
  WORKSPACE_BUNDLE_FORMAT,
  WORKSPACE_BUNDLE_SCHEMA_VERSION,
} from './archive-fs';
import { MemoryFileSystem } from './memory-fs';
import { OverlayFileSystem } from './overlay-fs';
import { PersistentFileSystem } from './persistent-fs';
import { VirtualJobManager } from './jobs';
import {
  VirtualShell,
  type VirtualCommandProvider,
  type VirtualShellOptions,
} from './shell';
import type { VirtualFileSystem } from './types';
import { SnapshotVcs, type SnapshotDiff, type SnapshotSummary } from './vcs';

export interface VirtualWorkspaceOptions {
  host?: HostBridge;
  vfs?: VirtualFileSystem;
  bundle?: WorkspaceBundle | Uint8Array;
  importFromHost?: boolean;
  storageKey?: string;
  now?: () => number;
  providers?: VirtualCommandProvider[];
  shell?: Omit<VirtualShellOptions, 'providers'>;
}

export interface VirtualWorkspaceStatus {
  head?: string;
  directory: string;
  fileCount: number;
  directoryCount: number;
  persistent: boolean;
}

/**
 * VirtualWorkspace combines the portable file, Shell and snapshot semantics
 * used by Agent tools. It never requires an OS filesystem, Bash or Git.
 */
export class VirtualWorkspace {
  readonly host: HostBridge;
  readonly fs: VirtualFileSystem;
  readonly shell: VirtualShell;
  readonly vcs: SnapshotVcs;
  readonly jobs: VirtualJobManager;
  readonly persistent: boolean;
  private readonly providers: VirtualCommandProvider[];
  private readonly now: () => number;
  private readonly storageKey: string;

  constructor(options: VirtualWorkspaceOptions = {}) {
    this.host = options.host ?? new MemoryHostBridge();
    assertHostCapabilities(this.host, []);
    this.now = options.now ?? (() => this.host.clock?.now() ?? Date.now());
    this.providers = [...(options.providers ?? [])];
    this.storageKey = options.storageKey ?? 'tinyai:workspace:v1';
    if (options.vfs) {
      this.fs = options.vfs;
      this.persistent = false;
    } else if (
      hasHostCapability(this.host, 'storage') &&
      this.host.storage
    ) {
      this.fs = new PersistentFileSystem(
        this.host.storage,
        this.storageKey,
        this.now
      );
      this.persistent = true;
    } else {
      this.fs = new MemoryFileSystem(this.now);
      this.persistent = false;
    }
    this.shell = new VirtualShell(this.fs, {
      ...(options.shell ?? {}),
      providers: this.providers,
    });
    this.vcs = new SnapshotVcs(this.fs, this.now);
    this.jobs = new VirtualJobManager(this.shell, {
      ...(hasHostCapability(this.host, 'storage') && this.host.storage
        ? { storage: this.host.storage }
        : {}),
      storageKey: `${this.storageKey}:jobs`,
      now: this.now,
    });
  }

  async initialize(
    bundle?: WorkspaceBundle | Uint8Array,
    options: { replace?: boolean } = {}
  ): Promise<void> {
    if (bundle) await importWorkspaceBundle(this.fs, bundle, options);
  }

  async checkpoint(label?: string): Promise<SnapshotSummary> {
    return this.vcs.commit(label);
  }

  async diff(fromId?: string, toId?: string): Promise<SnapshotDiff> {
    return this.vcs.diff(fromId, toId);
  }

  async restore(snapshotId: string): Promise<void> {
    await this.vcs.restore(snapshotId);
  }

  async status(): Promise<VirtualWorkspaceStatus> {
    const entries = await this.fs.list('', { recursive: true });
    return {
      ...(this.vcs.headId ? { head: this.vcs.headId } : {}),
      directory: this.shell.currentDirectory,
      fileCount: entries.filter((item) => item.kind === 'file').length,
      directoryCount: entries.filter((item) => item.kind === 'directory').length,
      persistent: this.persistent,
    };
  }

  async exportBundle(options: {
    metadata?: Record<string, string>;
    syncToHost?: boolean;
  } = {}): Promise<WorkspaceBundle> {
    const bundle = await exportWorkspaceBundle(this.fs, {
      now: this.now,
      metadata: options.metadata,
      ...(this.vcs.headId ? { revision: this.vcs.headId } : {}),
    });
    if (options.syncToHost) await this.syncToHost(bundle);
    return bundle;
  }

  async syncToHost(bundle?: WorkspaceBundle): Promise<void> {
    if (!hasHostCapability(this.host, 'workspace.export')) {
      throw new AgentError(
        'HOST_CAPABILITY_MISSING',
        `Host ${this.host.descriptor.id} does not support workspace.export`
      );
    }
    await this.host.workspace!.exportWorkspace!(
      serializeWorkspaceBundle(bundle ?? (await this.exportBundle()))
    );
  }

  fork(): VirtualWorkspace {
    const overlay = this.vcs.fork();
    return new VirtualWorkspace({
      host: this.host,
      vfs: overlay,
      now: this.now,
      providers: this.providers,
      shell: {
        cwd: this.shell.currentDirectory,
        env: { ...this.shell.environment },
      },
    });
  }

  async archive(): Promise<ArchiveFileSystem> {
    return new ArchiveFileSystem(await this.exportBundle(), this.now);
  }
}

export async function createVirtualWorkspace(
  options: VirtualWorkspaceOptions = {}
): Promise<VirtualWorkspace> {
  const workspace = new VirtualWorkspace(options);
  let bundle = options.bundle;
  if (options.importFromHost) {
    if (bundle) {
      throw new AgentError(
        'WORKSPACE_IMPORT_CONFLICT',
        'Pass either bundle or importFromHost, not both'
      );
    }
    if (!hasHostCapability(workspace.host, 'workspace.import')) {
      throw new AgentError(
        'HOST_CAPABILITY_MISSING',
        `Host ${workspace.host.descriptor.id} does not support workspace.import`
      );
    }
    bundle = await workspace.host.workspace!.importWorkspace!();
  }
  if (bundle) await workspace.initialize(bundle);
  return workspace;
}

export async function exportWorkspaceBundle(
  vfs: VirtualFileSystem,
  options: {
    now?: () => number;
    revision?: string;
    metadata?: Record<string, string>;
  } = {}
): Promise<WorkspaceBundle> {
  const entries = await vfs.list('', { recursive: true });
  const files: WorkspaceBundleFile[] = [];
  const directories: string[] = [];
  for (const entry of entries) {
    if (entry.kind === 'directory') {
      directories.push(entry.path);
      continue;
    }
    files.push({
      path: entry.path,
      dataBase64: bytesToBase64(await vfs.read(entry.path)),
      mode: entry.mode,
      modifiedAt: entry.modifiedAt,
    });
  }
  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    createdAt: options.now?.() ?? Date.now(),
    ...(options.revision ? { revision: options.revision } : {}),
    ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
    directories: directories.sort(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export async function importWorkspaceBundle(
  vfs: VirtualFileSystem,
  input: WorkspaceBundle | Uint8Array,
  options: { replace?: boolean } = {}
): Promise<WorkspaceBundle> {
  const bundle = parseWorkspaceBundle(input);
  if (options.replace) {
    const existing = await vfs.list('', { recursive: true });
    for (const entry of existing
      .filter((item) => item.kind === 'file')
      .sort((left, right) => right.path.length - left.path.length)) {
      await vfs.remove(entry.path);
    }
  }
  for (const directory of bundle.directories) {
    await vfs.mkdir(directory, { recursive: true });
  }
  for (const file of bundle.files) {
    await vfs.write(file.path, base64ToBytes(file.dataBase64), {
      ...(file.mode === undefined ? {} : { mode: file.mode }),
    });
  }
  return cloneBundle(bundle);
}

export function requiredWorkspaceCapabilities(
  workspace: VirtualWorkspace
): HostCapability[] {
  const required: HostCapability[] = [];
  if (workspace.persistent) required.push('storage');
  return required;
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
