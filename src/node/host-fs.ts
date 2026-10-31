import {
  copyFile,
  cp,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { AgentError } from '../core/errors';
import {
  normalizeVirtualPath,
  type VirtualFileInfo,
  type VirtualFileSystem,
  type VirtualFsEvent,
  type VirtualListOptions,
  type VirtualReadOptions,
  type VirtualWriteOptions,
} from '../virtual';

/**
 * Optional Node VFS provider for large projects. Paths remain virtual and are
 * fenced to one host root; data reads use file handles and byte ranges.
 */
export class NodeHostFileSystem implements VirtualFileSystem {
  private readonly root: string;
  private readonly versions = new Map<string, number>();
  private rootReal?: Promise<string>;

  constructor(root: string, private readonly now: () => number = () => Date.now()) {
    this.root = resolve(root);
  }

  async read(
    path: string,
    options: VirtualReadOptions = {}
  ): Promise<Uint8Array> {
    this.assertActive(options.signal);
    const absolute = await this.existing(path);
    const info = await stat(absolute);
    if (!info.isFile()) {
      throw new AgentError('VFS_NOT_FILE', `Virtual path is not a file: ${path}`);
    }
    const offset = Math.max(0, options.offset ?? 0);
    const length =
      options.length === undefined
        ? Math.max(0, info.size - offset)
        : Math.max(0, Math.min(options.length, info.size - offset));
    const handle = await open(absolute, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } finally {
      await handle.close();
    }
  }

  async write(
    path: string,
    data: Uint8Array,
    options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    this.assertActive(options.signal);
    const normalized = normalizeVirtualPath(path);
    const absolute = this.absolute(normalized);
    const parent = await this.ensureParent(normalized);
    const current = await this.stat(normalized).catch(() => undefined);
    if (options.expectedVersion !== undefined) {
      if ((current?.version ?? 0) !== options.expectedVersion) {
        throw new AgentError(
          'VFS_VERSION_CONFLICT',
          `Virtual file changed: ${normalized}`
        );
      }
    }
    const temporary = resolve(parent, `.tinyai-write-${process.pid}-${this.now()}`);
    await writeFile(temporary, data, {
      mode: options.mode ?? current?.mode ?? 0o644,
    });
    await rename(temporary, absolute);
    const version = (current?.version ?? 0) + 1;
    this.versions.set(normalized, version);
    return this.info(normalized, absolute, version);
  }

  async list(
    path = '',
    options: VirtualListOptions = {}
  ): Promise<VirtualFileInfo[]> {
    this.assertActive(options.signal);
    const normalized = normalizeVirtualPath(path);
    if (normalized) {
      const absolute = await this.existing(normalized);
      const info = await stat(absolute);
      if (!info.isDirectory()) return [await this.info(normalized, absolute)];
    }
    const start = normalized ? await this.existing(normalized) : this.root;
    const result: VirtualFileInfo[] = [];
    await this.walk(start, normalized, options.recursive === true, result, options.signal);
    return result.sort((left, right) => left.path.localeCompare(right.path));
  }

  async stat(
    path: string,
    signal?: AbortSignal
  ): Promise<VirtualFileInfo | undefined> {
    this.assertActive(signal);
    const normalized = normalizeVirtualPath(path);
    try {
      const absolute = await this.existing(normalized);
      return this.info(normalized, absolute);
    } catch (error) {
      if ((error as AgentError).code === 'VFS_NOT_FOUND') return undefined;
      throw error;
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<void> {
    await mkdir(this.absolute(normalizeVirtualPath(path)), {
      recursive: options.recursive === true,
    });
  }

  async remove(
    path: string,
    options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    const normalized = normalizeVirtualPath(path);
    try {
      const absolute = await this.existing(normalized);
      const info = await stat(absolute);
      if (info.isDirectory() && !options.recursive) {
        const entries = await readdir(absolute);
        if (entries.length) {
          throw new AgentError('VFS_NOT_EMPTY', `Directory is not empty: ${normalized}`);
        }
      }
      await rm(absolute, {
        recursive: options.recursive === true,
        force: false,
      });
      this.versions.delete(normalized);
      return true;
    } catch (error) {
      if ((error as AgentError).code === 'VFS_NOT_FOUND') return false;
      throw error;
    }
  }

  async rename(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    await this.existing(source);
    await this.ensureParent(target);
    await rename(this.absolute(source), this.absolute(target));
    const sourceVersion = this.versions.get(source) ?? 0;
    this.versions.delete(source);
    this.versions.set(target, sourceVersion + 1);
  }

  async copy(from: string, to: string): Promise<void> {
    const source = normalizeVirtualPath(from);
    const target = normalizeVirtualPath(to);
    const sourceAbsolute = await this.existing(source);
    const targetAbsolute = this.absolute(target);
    await this.ensureParent(target);
    const info = await stat(sourceAbsolute);
    if (info.isDirectory()) {
      await cp(sourceAbsolute, targetAbsolute, { recursive: true, force: false });
    } else {
      await copyFile(sourceAbsolute, targetAbsolute);
    }
    this.versions.set(target, 1);
  }

  watch(_listener: (event: VirtualFsEvent) => void): () => void {
    return () => undefined;
  }

  private async walk(
    absolute: string,
    virtualPath: string,
    recursive: boolean,
    result: VirtualFileInfo[],
    signal?: AbortSignal
  ): Promise<void> {
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      this.assertActive(signal);
      if (entry.isSymbolicLink()) continue;
      const childVirtual = virtualPath ? `${virtualPath}/${entry.name}` : entry.name;
      const childAbsolute = resolve(absolute, entry.name);
      result.push(await this.info(childVirtual, childAbsolute));
      if (entry.isDirectory() && recursive) {
        await this.walk(childAbsolute, childVirtual, true, result, signal);
      }
    }
  }

  private async info(
    path: string,
    absolute: string,
    version = this.versions.get(path) ?? 0
  ): Promise<VirtualFileInfo> {
    const value = await stat(absolute);
    return {
      path,
      kind: value.isDirectory() ? 'directory' : 'file',
      size: value.isDirectory() ? 0 : value.size,
      modifiedAt: value.mtimeMs,
      mode: value.mode & 0o777,
      version,
    };
  }

  private absolute(path: string): string {
    const absolute = resolve(this.root, ...path.split('/').filter(Boolean));
    if (absolute !== this.root && !absolute.startsWith(`${this.root}/`)) {
      throw new AgentError('VFS_PATH_INVALID', `Path escapes host workspace: ${path}`);
    }
    return absolute;
  }

  private async existing(path: string): Promise<string> {
    const absolute = this.absolute(normalizeVirtualPath(path));
    try {
      const resolved = await realpath(absolute);
      const root = await this.realRoot();
      if (resolved !== root && !resolved.startsWith(`${root}/`)) {
        throw new AgentError('VFS_PATH_INVALID', `Symlink escapes host workspace: ${path}`);
      }
      return resolved;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new AgentError('VFS_NOT_FOUND', `Virtual file not found: ${path}`);
      }
      throw error;
    }
  }

  private async ensureParent(path: string): Promise<string> {
    const parent = dirname(this.absolute(path));
    await mkdir(parent, { recursive: true });
    const resolved = await realpath(parent);
    const root = await this.realRoot();
    if (resolved !== root && !resolved.startsWith(`${root}/`)) {
      throw new AgentError('VFS_PATH_INVALID', `Parent escapes host workspace: ${path}`);
    }
    return resolved;
  }

  private assertActive(signal?: AbortSignal): void {
    if (signal?.aborted) {
      throw new AgentError('VFS_ABORTED', 'Host file operation was cancelled');
    }
  }

  private realRoot(): Promise<string> {
    this.rootReal ??= realpath(this.root);
    return this.rootReal;
  }
}
