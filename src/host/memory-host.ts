import type {
  HostBridge,
  HostCapability,
  HostClock,
  HostCrypto,
  HostDescriptor,
  HostStorage,
} from './types';

export interface MemoryHostBridgeOptions {
  descriptor?: Partial<Omit<HostDescriptor, 'capabilities'>> & {
    capabilities?: readonly HostCapability[];
  };
  storage?: HostStorage;
  clock?: HostClock;
  clone?: <T>(value: T) => T;
  crypto?: HostCrypto;
}

export class MemoryHostStorage implements HostStorage {
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

  async list(prefix = ''): Promise<string[]> {
    return [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }
}

export class MemoryHostBridge implements HostBridge {
  readonly descriptor: HostDescriptor;
  readonly storage: HostStorage;
  readonly clock: HostClock;
  readonly scheduler: HostBridge['scheduler'];
  readonly crypto: HostCrypto;
  readonly clone: HostBridge['clone'];

  constructor(options: MemoryHostBridgeOptions = {}) {
    this.storage = options.storage ?? new MemoryHostStorage();
    this.clock = options.clock ?? systemHostClock;
    this.scheduler = {
      setTimeout: (callback, delayMs) =>
        globalThis.setTimeout(callback, delayMs),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(
          handle as ReturnType<typeof globalThis.setTimeout>
        ),
      queueMicrotask: (callback) => globalThis.queueMicrotask(callback),
    };
    this.crypto = options.crypto ?? systemHostCrypto;
    this.clone = {
      clone: options.clone ?? (<T>(value: T): T => structuredClone(value)),
    };
    const provided: HostCapability[] = [
      'storage',
      'clock',
      'scheduler',
      'crypto',
      'clone',
    ];
    this.descriptor = {
      id: options.descriptor?.id ?? 'memory-host',
      platform: options.descriptor?.platform ?? 'portable',
      capabilities: options.descriptor?.capabilities ?? provided,
    };
  }
}

export const systemHostClock: HostClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(
      handle as ReturnType<typeof globalThis.setTimeout>
    ),
};

export const systemHostCrypto: HostCrypto = {
  async digest(algorithm, data) {
    if (algorithm !== 'SHA-256' || !globalThis.crypto?.subtle) {
      throw new Error('SHA-256 is unavailable in this host');
    }
    const digest = await globalThis.crypto.subtle.digest(
      algorithm,
      toArrayBuffer(data)
    );
    return new Uint8Array(digest);
  },
  randomBytes(length) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
};

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}
