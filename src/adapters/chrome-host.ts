import type {
  HostBridge,
  HostCapability,
  HostClock,
  HostCrypto,
  HostFileSystemBridge,
  HostStorage,
} from '../host';
import type { HostActionProvider } from '../platform/host-action';

export interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ChromeHostOptions {
  storage: ChromeStorageArea;
  id?: string;
  now?: () => number;
  actions?: HostActionProvider;
  filesystem?: HostFileSystemBridge;
}

export class ChromeHostStorage implements HostStorage {
  constructor(private readonly storage: ChromeStorageArea) {}

  async get(key: string): Promise<unknown> {
    return (await this.storage.get(key))[key];
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.storage.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.storage.remove(key);
  }

  async list(prefix = ''): Promise<string[]> {
    return Object.keys(await this.storage.get(null))
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}

export class ChromeHostBridge implements HostBridge {
  readonly descriptor;
  readonly storage: ChromeHostStorage;
  readonly filesystem?: HostFileSystemBridge;
  readonly clock: HostClock;
  readonly scheduler: NonNullable<HostBridge['scheduler']>;
  readonly crypto: HostCrypto;
  readonly clone: NonNullable<HostBridge['clone']>;
  readonly actions?: HostActionProvider;

  constructor(options: ChromeHostOptions) {
    this.storage = new ChromeHostStorage(options.storage);
    this.filesystem = options.filesystem;
    const now = options.now ?? (() => Date.now());
    this.clock = {
      now,
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    this.scheduler = {
      setTimeout: (callback, delay) => setTimeout(callback, delay),
      clearTimeout: (handle) =>
        clearTimeout(handle as ReturnType<typeof setTimeout>),
      queueMicrotask: (callback) => queueMicrotask(callback),
    };
    this.crypto = chromeCrypto;
    this.clone = { clone: <T>(value: T): T => structuredClone(value) };
    this.actions = options.actions;
    const capabilities: HostCapability[] = [
      'storage',
      ...(this.filesystem ? (['filesystem'] as const) : []),
      'clock',
      'scheduler',
      'crypto',
      'clone',
      ...(this.actions ? (['actions'] as const) : []),
    ];
    this.descriptor = {
      id: options.id ?? 'chrome-extension-host',
      platform: 'chrome',
      capabilities,
    };
  }
}

const chromeCrypto: HostCrypto = {
  async digest(algorithm, data) {
    if (algorithm !== 'SHA-256') {
      throw new Error(`Unsupported digest algorithm: ${algorithm}`);
    }
    const digest = await crypto.subtle.digest(
      algorithm,
      data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer
    );
    return new Uint8Array(digest);
  },
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    return bytes;
  },
};
