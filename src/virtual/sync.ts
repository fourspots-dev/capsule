import { AgentError } from '../core/errors';
import {
  parseWorkspaceBundle,
  type WorkspaceBundle,
} from './archive-fs';
import { normalizeVirtualPath } from './path';
import type { VirtualKeyValueStore } from './persistent-fs';
import { hashVirtualBytes } from './search';
import type { VirtualFileSystem } from './types';

export interface WorkspaceSyncChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
}

export interface WorkspaceSyncConflict {
  path: string;
  baselineHash?: string;
  localHash?: string;
  externalHash?: string;
}

export interface WorkspaceSyncPreview {
  changes: WorkspaceSyncChange[];
  conflicts: WorkspaceSyncConflict[];
}

interface PersistedSyncBaseline {
  schemaVersion: 1;
  files: Record<string, string>;
}

export class WorkspaceSyncService {
  private baseline?: Record<string, string>;
  private loading?: Promise<void>;

  constructor(
    private readonly vfs: VirtualFileSystem,
    options: {
      storage?: VirtualKeyValueStore;
      storageKey?: string;
    } = {}
  ) {
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? 'tinyai:workspace-sync:v1';
  }

  private readonly storage?: VirtualKeyValueStore;
  private readonly storageKey: string;

  async initialize(): Promise<void> {
    this.loading ??= this.load();
    await this.loading;
  }

  async captureBaseline(bundle: WorkspaceBundle | Uint8Array): Promise<void> {
    const parsed = parseWorkspaceBundle(bundle);
    this.baseline = Object.fromEntries(
      parsed.files.map((file) => [file.path, hashBase64(file.dataBase64)])
    );
    await this.persist();
  }

  async inspect(bundle: WorkspaceBundle | Uint8Array): Promise<WorkspaceSyncPreview> {
    await this.initialize();
    const parsed = parseWorkspaceBundle(bundle);
    const baseline = this.baseline ?? {};
    const local = await currentHashes(this.vfs);
    const external = Object.fromEntries(
      parsed.files.map((file) => [file.path, hashBase64(file.dataBase64)])
    );
    const paths = new Set([
      ...Object.keys(baseline),
      ...Object.keys(local),
      ...Object.keys(external),
    ]);
    const changes: WorkspaceSyncChange[] = [];
    const conflicts: WorkspaceSyncConflict[] = [];
    for (const path of [...paths].sort()) {
      const baseHash = baseline[path];
      const localHash = local[path];
      const externalHash = external[path];
      if (baseHash === externalHash) continue;
      const localChanged = baseHash !== localHash;
      const externalChanged = baseHash !== externalHash;
      if (localChanged && externalChanged && localHash !== externalHash) {
        conflicts.push({
          path,
          ...(baseHash ? { baselineHash: baseHash } : {}),
          ...(localHash ? { localHash } : {}),
          ...(externalHash ? { externalHash } : {}),
        });
      }
      changes.push({
        path,
        status: !baseHash && externalHash
          ? 'added'
          : baseHash && !externalHash
            ? 'deleted'
            : 'modified',
      });
    }
    return { changes, conflicts };
  }

  async apply(
    bundle: WorkspaceBundle | Uint8Array,
    options: {
      strategy?: 'reject' | 'ours' | 'theirs';
      signal?: AbortSignal;
    } = {}
  ): Promise<WorkspaceSyncPreview> {
    await this.initialize();
    const preview = await this.inspect(bundle);
    const strategy = options.strategy ?? 'reject';
    if (preview.conflicts.length && strategy === 'reject') {
      throw new AgentError(
        'WORKSPACE_SYNC_CONFLICT',
        `Workspace sync conflicts: ${preview.conflicts.map((item) => item.path).join(', ')}`,
        {
          details: {
            conflicts: preview.conflicts,
          } as unknown as import('../core/types').JsonValue,
        }
      );
    }
    const parsed = parseWorkspaceBundle(bundle);
    const conflictPaths = new Set(preview.conflicts.map((item) => item.path));
    const external = new Map(parsed.files.map((file) => [file.path, file]));
    for (const change of preview.changes) {
      if (options.signal?.aborted) {
        throw new AgentError('WORKSPACE_SYNC_CANCELLED', 'Workspace sync was cancelled');
      }
      if (strategy === 'ours' && conflictPaths.has(change.path)) continue;
      const file = external.get(change.path);
      if (file) {
        await this.vfs.write(
          normalizeVirtualPath(file.path),
          base64ToBytes(file.dataBase64),
          {
            ...(file.mode === undefined ? {} : { mode: file.mode }),
            signal: options.signal,
          }
        );
      } else {
        await this.vfs.remove(change.path, { recursive: true });
      }
    }
    this.baseline = Object.fromEntries(
      parsed.files.map((file) => [file.path, hashBase64(file.dataBase64)])
    );
    await this.persist();
    return preview;
  }

  private async load(): Promise<void> {
    const raw = await this.storage?.get(this.storageKey);
    if (!raw) return;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw as PersistedSyncBaseline).schemaVersion !== 1 ||
      !(raw as PersistedSyncBaseline).files ||
      typeof (raw as PersistedSyncBaseline).files !== 'object'
    ) {
      throw new AgentError('WORKSPACE_SYNC_STATE_INVALID', 'Workspace sync state is invalid');
    }
    this.baseline = { ...(raw as PersistedSyncBaseline).files };
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedSyncBaseline = {
      schemaVersion: 1,
      files: { ...(this.baseline ?? {}) },
    };
    await this.storage.set(this.storageKey, state);
  }
}

async function currentHashes(
  vfs: VirtualFileSystem
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const file of await vfs.list('', { recursive: true })) {
    if (file.kind === 'file') {
      result[file.path] = hashVirtualBytes(await vfs.read(file.path));
    }
  }
  return result;
}

function hashBase64(value: string): string {
  return hashVirtualBytes(base64ToBytes(value));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}
