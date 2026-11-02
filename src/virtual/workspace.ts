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
import {
  SnapshotVcs,
  unifiedDiff,
  type SnapshotDiff,
  type SnapshotSummary,
} from './vcs';
import { WorkspaceSyncService } from './sync';
import { hashVirtualBytes } from './search';

export interface VirtualWorkspaceOptions {
  host?: HostBridge;
  vfs?: VirtualFileSystem;
  bundle?: WorkspaceBundle | Uint8Array;
  importFromHost?: boolean;
  storageKey?: string;
  workspaceId?: string;
  now?: () => number;
  providers?: VirtualCommandProvider[];
  shell?: Omit<VirtualShellOptions, 'providers'>;
  persistVcs?: boolean;
  persistJobs?: boolean;
  vcsStorageKey?: string;
  jobsStorageKey?: string;
  parent?: VirtualWorkspace;
  forkBaseHashes?: Readonly<Record<string, string>>;
}

export interface VirtualWorkspaceStatus {
  head?: string;
  directory: string;
  fileCount: number;
  directoryCount: number;
  persistent: boolean;
}

export interface VirtualMergePreview {
  parentWorkspaceId?: string;
  childWorkspaceId?: string;
  changes: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted';
    patch?: string;
  }>;
  conflicts: Array<{
    path: string;
    reason: 'parent_changed' | 'parent_deleted';
    parentHash?: string;
    forkBaseHash?: string;
    childHash?: string;
  }>;
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
  readonly sync: WorkspaceSyncService;
  readonly workspaceId: string;
  readonly parent?: VirtualWorkspace;
  private readonly forkBaseHashes?: Record<string, string>;
  private readonly id: string;
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
    this.id = options.storageKey ?? `workspace_${Math.random().toString(36).slice(2)}`;
    this.workspaceId = options.workspaceId ?? this.id;
    this.parent = options.parent;
    this.forkBaseHashes = options.forkBaseHashes
      ? { ...options.forkBaseHashes }
      : undefined;
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
    this.vcs = new SnapshotVcs(this.fs, this.now, {
      ...(options.persistVcs !== false &&
      hasHostCapability(this.host, 'storage') &&
      this.host.storage
        ? {
            storage: this.host.storage,
            storageKey: options.vcsStorageKey ?? `${this.storageKey}:vcs`,
          }
        : {}),
    });
    this.jobs = new VirtualJobManager(this.shell, {
      ...(options.persistJobs !== false &&
      hasHostCapability(this.host, 'storage') &&
      this.host.storage
        ? {
            storage: this.host.storage,
            storageKey: options.jobsStorageKey ?? `${this.storageKey}:jobs`,
          }
        : {}),
      now: this.now,
    });
    this.sync = new WorkspaceSyncService(this.fs, {
      ...(hasHostCapability(this.host, 'storage') && this.host.storage
        ? {
            storage: this.host.storage,
            storageKey: `${this.storageKey}:sync`,
          }
        : {}),
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

  async generation(): Promise<number> {
    const entries = await this.fs.list('', { recursive: true });
    let hash = 0x811c9dc5;
    for (const entry of entries) {
      const value = `${entry.path}\0${entry.kind}\0${entry.version}\0${entry.size}\0${entry.modifiedAt}`;
      for (let index = 0; index < value.length; index += 1) {
        hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
      }
    }
    return hash >>> 0;
  }

  async diff(fromId?: string, toId?: string): Promise<SnapshotDiff> {
    return this.vcs.diff(fromId, toId);
  }

  async restore(snapshotId: string): Promise<void> {
    await this.vcs.restore(snapshotId);
  }

  async status(): Promise<VirtualWorkspaceStatus> {
    await this.vcs.initialize();
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
    await this.vcs.initialize();
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

  async fork(): Promise<VirtualWorkspace> {
    const baseHashes = await currentHashes(this.fs);
    const overlay = this.vcs.fork();
    return new VirtualWorkspace({
      host: this.host,
      vfs: overlay,
      now: this.now,
      providers: this.providers,
      persistVcs: false,
      persistJobs: false,
      parent: this,
      forkBaseHashes: baseHashes,
      shell: {
        cwd: this.shell.currentDirectory,
        env: { ...this.shell.environment },
      },
    });
  }

  async previewMerge(child: VirtualWorkspace): Promise<VirtualMergePreview> {
    if (child.parent !== this || !(child.fs instanceof OverlayFileSystem)) {
      throw new AgentError(
        'WORKSPACE_MERGE_INVALID',
        'Child workspace is not a fork of this workspace'
      );
    }
    const changes = await child.fs.changes();
    const base = child.forkBaseHashes ?? {};
    const preview: VirtualMergePreview = {
      parentWorkspaceId: this.workspaceId,
      childWorkspaceId: child.workspaceId,
      changes: [],
      conflicts: [],
    };
    for (const write of changes.written.sort((left, right) => left.path.localeCompare(right.path))) {
      const parentData = await this.fs.read(write.path).catch(() => undefined);
      const parentHash = parentData ? hashVirtualBytes(parentData) : undefined;
      const childHash = hashVirtualBytes(write.data);
      if (parentHash !== base[write.path] && parentHash !== childHash) {
        preview.conflicts.push({
          path: write.path,
          reason: parentHash === undefined ? 'parent_deleted' : 'parent_changed',
          ...(parentHash ? { parentHash } : {}),
          ...(base[write.path] ? { forkBaseHash: base[write.path] } : {}),
          childHash,
        });
      }
      const patch = unifiedDiff(
        parentData ?? new Uint8Array(),
        write.data,
        write.path
      ).patch;
      preview.changes.push({
        path: write.path,
        status: parentData ? 'modified' : 'added',
        ...(patch ? { patch } : {}),
      });
    }
    for (const path of changes.deleted.sort()) {
      const parentData = await this.fs.read(path).catch(() => undefined);
      const parentHash = parentData ? hashVirtualBytes(parentData) : undefined;
      if (parentData && parentHash !== base[path]) {
        preview.conflicts.push({
          path,
          reason: 'parent_changed',
          parentHash,
          ...(base[path] ? { forkBaseHash: base[path] } : {}),
        });
      }
      const patch = unifiedDiff(
        parentData ?? new Uint8Array(),
        new Uint8Array(),
        path
      ).patch;
      preview.changes.push({
        path,
        status: 'deleted',
        ...(patch ? { patch } : {}),
      });
    }
    return preview;
  }

  async applyMerge(child: VirtualWorkspace): Promise<VirtualMergePreview> {
    const preview = await this.previewMerge(child);
    if (preview.conflicts.length) {
      throw new AgentError(
        'WORKSPACE_MERGE_CONFLICT',
        `Workspace merge conflicts: ${preview.conflicts.map((item) => item.path).join(', ')}`,
        {
          details: {
            conflicts: preview.conflicts,
          } as unknown as import('../core/types').JsonValue,
        }
      );
    }
    if (!(child.fs instanceof OverlayFileSystem)) {
      throw new AgentError('WORKSPACE_MERGE_INVALID', 'Child workspace is not an overlay');
    }
    await this.vcs.applyChanges(await child.fs.changes());
    await this.checkpoint(`merge:${child.workspaceId}`);
    return preview;
  }

  async discardFork(child: VirtualWorkspace): Promise<void> {
    if (child.parent !== this || !(child.fs instanceof OverlayFileSystem)) {
      throw new AgentError('WORKSPACE_MERGE_INVALID', 'Child workspace is not a fork');
    }
    await child.fs.discard();
  }

  async archive(): Promise<ArchiveFileSystem> {
    return new ArchiveFileSystem(await this.exportBundle(), this.now);
  }
}

async function currentHashes(
  vfs: VirtualFileSystem
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const file of await vfs.list('', { recursive: true })) {
    if (file.kind === 'file') {
      hashes[file.path] = hashVirtualBytes(await vfs.read(file.path));
    }
  }
  return hashes;
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
