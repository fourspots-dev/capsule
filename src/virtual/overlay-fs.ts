import { AgentError } from '../core/errors';
import { MemoryFileSystem } from './memory-fs';
import {
  isPathInside,
  normalizeVirtualPath,
  parentVirtualPath,
} from './path';
import type {
  VirtualChangeSet,
  VirtualFileInfo,
  VirtualFileSystem,
  VirtualFsEvent,
  VirtualListOptions,
  VirtualReadOptions,
  VirtualWriteOptions,
} from './types';

export class OverlayFileSystem implements VirtualFileSystem {
  private readonly overlay: MemoryFileSystem;
  private readonly deleted = new Set<string>();

  constructor(
    private readonly base: VirtualFileSystem,
    now: () => number = () => Date.now()
  ) {
    this.overlay = new MemoryFileSystem(now);
  }

  async read(
    path: string,
    options: VirtualReadOptions = {}
  ): Promise<Uint8Array> {
    const normalized = normalizeVirtualPath(path);
    if (this.deleted.has(normalized)) throw notFound(normalized);
    try {
      return await this.overlay.read(normalized, options);
    } catch (error) {
      if (!(error instanceof AgentError) || error.code !== 'VFS_NOT_FOUND') throw error;
      return this.base.read(normalized, options);
    }
  }

  async write(
    path: string,
    data: Uint8Array,
    options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    const normalized = normalizeVirtualPath(path);
    if (this.deleted.has(normalized)) this.deleted.delete(normalized);
    return this.overlay.write(normalized, data, options);
  }

  async list(
    path = '',
    options: VirtualListOptions = {}
  ): Promise<VirtualFileInfo[]> {
    const normalized = normalizeVirtualPath(path);
    const merged = new Map<string, VirtualFileInfo>();
    for (const item of await this.base.list(normalized, {
      recursive: true,
      signal: options.signal,
    })) {
      if (!this.deleted.has(item.path)) merged.set(item.path, item);
    }
    for (const item of await this.overlay.list(normalized, { recursive: true })) {
      merged.set(item.path, item);
    }
    for (const path of this.deleted) {
      merged.delete(path);
    }
    if (!options.recursive) {
      for (const item of [...merged.values()]) {
        const parent = parentVirtualPath(item.path);
        if (parent !== normalized) merged.delete(item.path);
      }
    }
    return [...merged.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  async stat(path: string, signal?: AbortSignal): Promise<VirtualFileInfo | undefined> {
    const normalized = normalizeVirtualPath(path);
    if (this.deleted.has(normalized)) return undefined;
    return (
      (await this.overlay.stat(normalized, signal)) ??
      (await this.base.stat(normalized, signal))
    );
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    const normalized = normalizeVirtualPath(path);
    this.deleted.delete(normalized);
    await this.overlay.mkdir(normalized, options);
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    const baseItems = (await this.base.list(normalized, { recursive: true })).filter(
      (item) => isPathInside(item.path, normalized)
    );
    if (
      baseItems.some((item) => item.kind === 'directory') &&
      baseItems.some((item) => item.kind === 'file') &&
      !options.recursive
    ) {
      throw new AgentError('VFS_NOT_EMPTY', `Directory is not empty: ${normalized}`);
    }
    const overlayDeleted = await this.overlay.remove(normalized, {
      recursive: true,
    });
    let changed = false;
    if (baseItems.length || (await this.base.stat(normalized))) {
      this.deleted.add(normalized);
      changed = true;
    }
    return changed || overlayDeleted;
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    const data = await this.read(source);
    await this.write(target, data);
    await this.remove(source, { recursive: true });
  }

  async copy(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    const sourceInfo = await this.stat(source);
    if (!sourceInfo) throw notFound(source);
    if (sourceInfo.kind === 'file') {
      await this.write(target, await this.read(source), { mode: sourceInfo.mode });
      return;
    }
    await this.mkdir(target, { recursive: true });
    for (const item of await this.list(source, { recursive: true })) {
      const relative = item.path.slice(source.length);
      if (item.kind === 'file') {
        await this.write(`${target}${relative}`, await this.read(item.path), {
          mode: item.mode,
        });
      }
    }
  }

  watch(listener: (event: VirtualFsEvent) => void): () => void {
    return this.overlay.watch(listener);
  }

  async changes(): Promise<VirtualChangeSet> {
    const written = [];
    for (const item of await this.overlay.list('', { recursive: true })) {
      if (item.kind !== 'file') continue;
      written.push({
        path: item.path,
        data: await this.overlay.read(item.path),
        mode: item.mode,
      });
    }
    return { written, deleted: [...this.deleted].sort() };
  }

  async discard(): Promise<void> {
    for (const item of await this.overlay.list('', { recursive: true })) {
      await this.overlay.remove(item.path, { recursive: true });
    }
    this.deleted.clear();
  }
}

function notFound(path: string): AgentError {
  return new AgentError('VFS_NOT_FOUND', `Virtual file not found: ${path}`);
}
