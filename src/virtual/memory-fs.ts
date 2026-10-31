import { AgentError } from '../core/errors';
import {
  normalizeVirtualPath,
  parentVirtualPath,
  pathSegments,
} from './path';
import type {
  VirtualFileInfo,
  VirtualFileSystem,
  VirtualFsEvent,
  VirtualListOptions,
  VirtualReadOptions,
  VirtualWriteOptions,
} from './types';

interface MemoryEntry {
  data: Uint8Array;
  modifiedAt: number;
  mode: number;
  version: number;
}

export class MemoryFileSystem implements VirtualFileSystem {
  private readonly files = new Map<string, MemoryEntry>();
  private readonly directories = new Set<string>(['']);
  private readonly locks = new Map<string, Promise<void>>();
  private readonly watchers = new Set<(event: VirtualFsEvent) => void>();
  private readonly sequence = new Map<string, number>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async read(
    path: string,
    options: VirtualReadOptions = {}
  ): Promise<Uint8Array> {
    this.assertActive(options.signal);
    const normalized = normalizeVirtualPath(path);
    const entry = this.files.get(normalized);
    if (!entry) throw fileNotFound(normalized);
    const offset = Math.max(0, options.offset ?? 0);
    const end =
      options.length === undefined
        ? entry.data.byteLength
        : offset + Math.max(0, options.length);
    return new Uint8Array(entry.data.subarray(offset, end));
  }

  async write(
    path: string,
    data: Uint8Array,
    options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    const normalized = normalizeVirtualPath(path);
    return this.withLock(normalized, async () => {
      this.assertActive(options.signal);
      const existing = this.files.get(normalized);
      if (
        options.expectedVersion !== undefined &&
        (existing?.version ?? 0) !== options.expectedVersion
      ) {
        throw new AgentError(
          'VFS_VERSION_CONFLICT',
          `Virtual file changed: ${normalized}`
        );
      }
      this.ensureParents(normalized);
      const version = (this.sequence.get(normalized) ?? existing?.version ?? 0) + 1;
      this.sequence.set(normalized, version);
      const entry: MemoryEntry = {
        data: new Uint8Array(data),
        modifiedAt: this.now(),
        mode: options.mode ?? existing?.mode ?? 0o644,
        version,
      };
      this.files.set(normalized, entry);
      this.emit(existing ? 'changed' : 'created', normalized);
      return info(normalized, entry);
    });
  }

  async list(
    path = '',
    options: VirtualListOptions = {}
  ): Promise<VirtualFileInfo[]> {
    this.assertActive(options.signal);
    const normalized = normalizeVirtualPath(path);
    if (normalized && !this.directories.has(normalized)) {
      const file = this.files.get(normalized);
      return file ? [info(normalized, file)] : [];
    }
    const prefix = normalized ? `${normalized}/` : '';
    const result: VirtualFileInfo[] = [];
    for (const directory of [...this.directories].sort()) {
      if (directory === normalized || !directory.startsWith(prefix)) continue;
      if (!options.recursive && directory.slice(prefix.length).includes('/')) continue;
      result.push({
        path: directory,
        kind: 'directory',
        size: 0,
        modifiedAt: 0,
        mode: 0o755,
        version: 0,
      });
    }
    for (const [filePath, entry] of [...this.files.entries()].sort()) {
      if (!filePath.startsWith(prefix)) continue;
      if (!options.recursive && filePath.slice(prefix.length).includes('/')) continue;
      result.push(info(filePath, entry));
    }
    return result;
  }

  async stat(path: string, signal?: AbortSignal): Promise<VirtualFileInfo | undefined> {
    this.assertActive(signal);
    const normalized = normalizeVirtualPath(path);
    const file = this.files.get(normalized);
    if (file) return info(normalized, file);
    return this.directories.has(normalized)
      ? {
          path: normalized,
          kind: 'directory',
          size: 0,
          modifiedAt: 0,
          mode: 0o755,
          version: 0,
        }
      : undefined;
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizeVirtualPath(path);
    if (this.files.has(normalized)) {
      throw new AgentError('VFS_NOT_DIRECTORY', `Not a directory: ${normalized}`);
    }
    const segments = pathSegments(normalized);
    for (let index = 1; index <= segments.length; index += 1) {
      const current = segments.slice(0, index).join('/');
      if (!options.recursive && current !== normalized && !this.directories.has(current)) {
        throw new AgentError('VFS_PARENT_MISSING', `Parent missing: ${parentVirtualPath(current)}`);
      }
      this.directories.add(current);
    }
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    const deletedFile = this.files.delete(normalized);
    const descendants = [...this.files.keys()].filter((item) =>
      item.startsWith(`${normalized}/`)
    );
    const descendantDirs = [...this.directories].filter((item) =>
      item.startsWith(`${normalized}/`)
    );
    if ((descendants.length || descendantDirs.length) && !options.recursive) {
      this.files.delete(normalized);
      throw new AgentError('VFS_NOT_EMPTY', `Directory is not empty: ${normalized}`);
    }
    for (const item of descendants) this.files.delete(item);
    for (const item of descendantDirs) this.directories.delete(item);
    const deletedDirectory = this.directories.delete(normalized);
    if (deletedFile || deletedDirectory || descendants.length) {
      this.emit('deleted', normalized);
      return true;
    }
    return false;
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    if (!this.files.has(source) && !this.directories.has(source)) {
      throw fileNotFound(source);
    }
    if (this.files.has(target) || this.directories.has(target)) {
      throw new AgentError('VFS_ALREADY_EXISTS', `Path exists: ${target}`);
    }
    const file = this.files.get(source);
    if (file) {
      this.ensureParents(target);
      this.files.set(target, file);
      this.files.delete(source);
      this.emit('deleted', source);
      this.emit('created', target);
      return;
    }
    this.ensureParents(target);
    for (const directory of [...this.directories]) {
      if (directory === source || directory.startsWith(`${source}/`)) {
        this.directories.delete(directory);
        this.directories.add(`${target}${directory.slice(source.length)}`);
      }
    }
    for (const [path, entry] of [...this.files]) {
      if (!path.startsWith(`${source}/`)) continue;
      this.files.delete(path);
      this.files.set(`${target}${path.slice(source.length)}`, entry);
    }
  }

  async copy(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    const file = this.files.get(source);
    if (file) {
      await this.write(target, file.data, { mode: file.mode });
      return;
    }
    if (!this.directories.has(source)) throw fileNotFound(source);
    await this.mkdir(target, { recursive: true });
    const entries = await this.list(source, { recursive: true });
    for (const entry of entries) {
      const relative = entry.path.slice(source.length);
      if (entry.kind === 'directory') {
        await this.mkdir(`${target}${relative}`, { recursive: true });
      } else {
        const data = await this.read(entry.path);
        await this.write(`${target}${relative}`, data, { mode: entry.mode });
      }
    }
  }

  watch(listener: (event: VirtualFsEvent) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  private ensureParents(path: string): void {
    let parent = parentVirtualPath(path);
    while (parent) {
      if (this.files.has(parent)) {
        throw new AgentError('VFS_NOT_DIRECTORY', `Not a directory: ${parent}`);
      }
      this.directories.add(parent);
      parent = parentVirtualPath(parent);
    }
  }

  private emit(type: VirtualFsEvent['type'], path: string): void {
    const event = { type, path } as VirtualFsEvent;
    for (const watcher of this.watchers) watcher(event);
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AgentError('VFS_ABORTED', 'Virtual file operation was cancelled');
    }
  }

  private async withLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.locks.set(path, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(path) === current) this.locks.delete(path);
    }
  }
}

function info(path: string, entry: MemoryEntry): VirtualFileInfo {
  return {
    path,
    kind: 'file',
    size: entry.data.byteLength,
    modifiedAt: entry.modifiedAt,
    mode: entry.mode,
    version: entry.version,
  };
}

function fileNotFound(path: string): AgentError {
  return new AgentError('VFS_NOT_FOUND', `Virtual file not found: ${path}`);
}
