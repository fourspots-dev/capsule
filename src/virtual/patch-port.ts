import type {
  VirtualFileInfo,
  VirtualReadOptions,
  VirtualWriteOptions,
} from './types';

export interface PatchFileSystem {
  read(path: string, options?: VirtualReadOptions): Promise<Uint8Array>;
  write(
    path: string,
    data: Uint8Array,
    options?: VirtualWriteOptions
  ): Promise<VirtualFileInfo>;
  stat(path: string, signal?: AbortSignal): Promise<VirtualFileInfo | undefined>;
  remove(
    path: string,
    options?: { recursive?: boolean }
  ): Promise<boolean>;
}
