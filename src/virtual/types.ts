export type VirtualPath = string;

export interface VirtualFileInfo {
  path: VirtualPath;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  mode: number;
  version: number;
}

export interface VirtualReadOptions {
  offset?: number;
  length?: number;
  signal?: AbortSignal;
}

export interface VirtualWriteOptions {
  signal?: AbortSignal;
  expectedVersion?: number;
  mode?: number;
}

export interface VirtualListOptions {
  recursive?: boolean;
  signal?: AbortSignal;
}

export interface VirtualFileSystem {
  read(path: VirtualPath, options?: VirtualReadOptions): Promise<Uint8Array>;
  write(
    path: VirtualPath,
    data: Uint8Array,
    options?: VirtualWriteOptions
  ): Promise<VirtualFileInfo>;
  list(
    path?: VirtualPath,
    options?: VirtualListOptions
  ): Promise<VirtualFileInfo[]>;
  stat(path: VirtualPath, signal?: AbortSignal): Promise<VirtualFileInfo | undefined>;
  mkdir(path: VirtualPath, options?: { recursive?: boolean }): Promise<void>;
  remove(path: VirtualPath, options?: { recursive?: boolean }): Promise<boolean>;
  rename(from: VirtualPath, to: VirtualPath): Promise<void>;
  copy(from: VirtualPath, to: VirtualPath): Promise<void>;
  watch?(listener: (event: VirtualFsEvent) => void): () => void;
}

export type VirtualFsEvent =
  | { type: 'created'; path: VirtualPath }
  | { type: 'changed'; path: VirtualPath }
  | { type: 'deleted'; path: VirtualPath };

export interface VirtualChangeSet {
  written: Array<{ path: VirtualPath; data: Uint8Array; mode: number }>;
  deleted: VirtualPath[];
}
