import { AgentError } from '../core/errors';
import { joinVirtualPath, normalizeVirtualPath } from './path';
import type {
  VirtualFileInfo,
  VirtualFileSystem,
  VirtualFsEvent,
} from './types';
import { workspacePath } from '../platform/workspace-resource';

export class ScopedFileSystem implements VirtualFileSystem {
  private readonly prefix: string;

  constructor(
    private readonly parent: VirtualFileSystem,
    prefix: string
  ) {
    this.prefix = normalizeVirtualPath(prefix);
    if (!this.prefix) {
      throw new AgentError(
        'WORKSPACE_SCOPE_INVALID',
        'Scoped file system requires a non-empty root prefix'
      );
    }
  }

  async read(
    path: string,
    options?: import('./types').VirtualReadOptions
  ): Promise<Uint8Array> {
    return this.parent.read(this.internal(path), options);
  }

  async write(
    path: string,
    data: Uint8Array,
    options?: import('./types').VirtualWriteOptions
  ): Promise<VirtualFileInfo> {
    return this.externalInfo(
      await this.parent.write(this.internal(path), data, options)
    );
  }

  async list(
    path = '',
    options?: import('./types').VirtualListOptions
  ): Promise<VirtualFileInfo[]> {
    return (await this.parent.list(this.internal(path, true), options)).map(
      (info) => this.externalInfo(info)
    );
  }

  async stat(
    path: string,
    signal?: AbortSignal
  ): Promise<VirtualFileInfo | undefined> {
    const info = await this.parent.stat(this.internal(path, true), signal);
    return info ? this.externalInfo(info) : undefined;
  }

  async mkdir(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<void> {
    await this.parent.mkdir(this.internal(path), options);
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<boolean> {
    return this.parent.remove(this.internal(path), options);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.parent.rename(this.internal(from), this.internal(to));
  }

  async copy(from: string, to: string): Promise<void> {
    await this.parent.copy(this.internal(from), this.internal(to));
  }

  watch(listener: (event: VirtualFsEvent) => void): () => void {
    if (!this.parent.watch) return () => undefined;
    return this.parent.watch((event) => {
      const path = this.externalPath(event.path);
      if (path !== undefined) listener({ ...event, path });
    });
  }

  private internal(path: string, allowRoot = false): string {
    const normalized = workspacePath(path, { allowRoot });
    if (!normalized && !allowRoot) {
      throw new AgentError(
        'WORKSPACE_PATH_INVALID',
        'Workspace root cannot be used as a file'
      );
    }
    return normalized
      ? joinVirtualPath(this.prefix, normalized)
      : this.prefix;
  }

  private externalInfo(info: VirtualFileInfo): VirtualFileInfo {
    const path = this.externalPath(info.path);
    if (path === undefined) {
      throw new AgentError(
        'WORKSPACE_SCOPE_MISMATCH',
        `File system path is outside the scoped workspace: ${info.path}`
      );
    }
    return { ...info, path };
  }

  private externalPath(path: string): string | undefined {
    const normalized = normalizeVirtualPath(path);
    if (normalized === this.prefix) return '';
    const start = `${this.prefix}/`;
    return normalized.startsWith(start)
      ? normalized.slice(start.length)
      : undefined;
  }
}
