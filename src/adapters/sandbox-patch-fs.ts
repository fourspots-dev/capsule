import { AgentError } from '../core/errors';
import type { SandboxProvider, WorkspaceLease } from '../core/sandbox-provider';
import type {
  PatchFileSystem,
  VirtualFileInfo,
  VirtualReadOptions,
  VirtualWriteOptions,
} from '../virtual';

export class SandboxPatchFileSystem implements PatchFileSystem {
  private readonly cache = new Map<
    string,
    { data: Uint8Array; info: VirtualFileInfo }
  >();

  constructor(
    private readonly provider: SandboxProvider,
    private readonly lease: WorkspaceLease
  ) {}

  async read(
    path: string,
    options: VirtualReadOptions = {}
  ): Promise<Uint8Array> {
    const cached = this.cache.get(path);
    if (cached) return new Uint8Array(cached.data);
    const info = await this.stat(path, options.signal);
    if (!info) {
      throw new AgentError('SANDBOX_FILE_NOT_FOUND', `File not found: ${path}`);
    }
    return new Uint8Array(this.cache.get(path)!.data);
  }

  async stat(
    path: string,
    signal?: AbortSignal
  ): Promise<VirtualFileInfo | undefined> {
    const cached = this.cache.get(path);
    if (cached) return { ...cached.info };
    try {
      const file = await this.provider.readFile(this.lease, path, signal);
      const info: VirtualFileInfo = {
        path,
        kind: 'file',
        size: file.data.byteLength,
        modifiedAt: file.modifiedAt,
        mode: file.mode ?? 0o644,
        version: Math.max(1, Math.trunc(file.modifiedAt)),
      };
      this.cache.set(path, { data: new Uint8Array(file.data), info });
      return { ...info };
    } catch (error) {
      if (
        error instanceof AgentError &&
        ['SANDBOX_FILE_NOT_FOUND', 'SANDBOX_PATH_NOT_FOUND'].includes(error.code)
      ) {
        return undefined;
      }
      throw error;
    }
  }

  async write(
    path: string,
    data: Uint8Array,
    options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    const current = await this.stat(path, options.signal);
    if (
      options.expectedVersion !== undefined &&
      (current?.version ?? 0) !== options.expectedVersion
    ) {
      throw new AgentError(
        'VFS_VERSION_CONFLICT',
        `Expected version ${options.expectedVersion} for ${path}, found ${current?.version ?? 0}`
      );
    }
    const file = await this.provider.writeFile(this.lease, path, data, {
      signal: options.signal,
    });
    const info: VirtualFileInfo = {
      path,
      kind: 'file',
      size: file.data.byteLength,
      modifiedAt: file.modifiedAt,
      mode: options.mode ?? file.mode ?? current?.mode ?? 0o644,
      version: Math.max(1, Math.trunc(file.modifiedAt)),
    };
    this.cache.set(path, { data: new Uint8Array(file.data), info });
    return { ...info };
  }

  async remove(
    path: string,
    _options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    this.cache.delete(path);
    return this.provider.deleteFile(this.lease, path);
  }
}
