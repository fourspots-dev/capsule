import { AgentError } from '../core/errors';
import { MemoryFileSystem } from './memory-fs';
import { normalizeVirtualPath } from './path';
import type {
  VirtualFileInfo,
  VirtualFileSystem,
  VirtualFsEvent,
  VirtualListOptions,
  VirtualReadOptions,
  VirtualWriteOptions,
} from './types';

export interface VirtualKeyValueStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export class MemoryKeyValueStore implements VirtualKeyValueStore {
  private readonly values = new Map<string, unknown>();

  async get(key: string): Promise<unknown> {
    return structuredClone(this.values.get(key));
  }

  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.values.delete(key);
  }
}

interface PersistentManifest {
  schemaVersion: 1;
  directories: string[];
  files: Array<{
    path: string;
    data: string;
    mode: number;
    modifiedAt: number;
    version: number;
  }>;
}

export class PersistentFileSystem implements VirtualFileSystem {
  private readonly memory: MemoryFileSystem;
  private loaded?: Promise<void>;

  constructor(
    private readonly storage: VirtualKeyValueStore,
    private readonly storageKey = 'tinyai:vfs:v1',
    now: () => number = () => Date.now()
  ) {
    this.memory = new MemoryFileSystem(now);
  }

  async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    await this.ensureLoaded();
    return this.memory.read(path, options);
  }

  async write(
    path: string,
    data: Uint8Array,
    options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    await this.ensureLoaded();
    const info = await this.memory.write(path, data, options);
    await this.persist();
    return info;
  }

  async list(
    path = '',
    options: VirtualListOptions = {}
  ): Promise<VirtualFileInfo[]> {
    await this.ensureLoaded();
    return this.memory.list(path, options);
  }

  async stat(path: string, signal?: AbortSignal): Promise<VirtualFileInfo | undefined> {
    await this.ensureLoaded();
    return this.memory.stat(path, signal);
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await this.ensureLoaded();
    await this.memory.mkdir(path, options);
    await this.persist();
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    await this.ensureLoaded();
    const removed = await this.memory.remove(path, options);
    if (removed) await this.persist();
    return removed;
  }

  async rename(from: string, to: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.rename(from, to);
    await this.persist();
  }

  async copy(from: string, to: string): Promise<void> {
    await this.ensureLoaded();
    await this.memory.copy(from, to);
    await this.persist();
  }

  watch(listener: (event: VirtualFsEvent) => void): () => void {
    return this.memory.watch(listener);
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  private async load(): Promise<void> {
    const raw = await this.storage.get(this.storageKey);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const manifest = raw as PersistentManifest;
    if (manifest.schemaVersion !== 1) {
      throw new AgentError(
        'VFS_SCHEMA_UNSUPPORTED',
        `Unsupported VFS schema: ${String(manifest.schemaVersion)}`
      );
    }
    for (const directory of manifest.directories ?? []) {
      await this.memory.mkdir(normalizeVirtualPath(directory), { recursive: true });
    }
    for (const file of manifest.files ?? []) {
      const path = normalizeVirtualPath(file.path);
      await this.memory.write(path, base64ToBytes(file.data), {
        mode: file.mode,
      });
    }
  }

  private async persist(): Promise<void> {
    const items = await this.memory.list('', { recursive: true });
    const manifest: PersistentManifest = {
      schemaVersion: 1,
      directories: items
        .filter((item) => item.kind === 'directory')
        .map((item) => item.path),
      files: [],
    };
    for (const item of items) {
      if (item.kind !== 'file') continue;
      manifest.files.push({
        path: item.path,
        data: bytesToBase64(await this.memory.read(item.path)),
        mode: item.mode,
        modifiedAt: item.modifiedAt,
        version: item.version,
      });
    }
    await this.storage.set(this.storageKey, manifest);
  }
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
