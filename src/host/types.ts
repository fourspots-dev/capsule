export type HostCapability =
  | 'storage'
  | 'workspace.import'
  | 'workspace.export'
  | 'workspace.picker'
  | 'terminal'
  | 'process'
  | 'pty'
  | 'network'
  | 'clock'
  | 'scheduler'
  | 'crypto'
  | 'clone';

export interface HostDescriptor {
  id: string;
  platform?: string;
  capabilities: readonly HostCapability[];
}

export interface HostStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
  list?(prefix?: string): Promise<string[]>;
}

export interface HostClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface HostScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  queueMicrotask(callback: () => void): void;
}

export interface HostCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<Uint8Array>;
  randomBytes?(length: number): Uint8Array;
}

export interface HostClone {
  clone<T>(value: T): T;
}

export interface HostTerminal {
  write(data: string): void | Promise<void>;
  onInput(listener: (data: string) => void): () => void;
  size?(): { columns: number; rows: number };
  onResize?(
    listener: (size: { columns: number; rows: number }) => void
  ): () => void;
}

export interface HostProcessRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  env?: Readonly<Record<string, string>>;
  stdin?: Uint8Array;
  signal?: AbortSignal;
}

export interface HostProcessResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface HostProcessBridge {
  execute(request: HostProcessRequest): Promise<HostProcessResult>;
}

export interface HostNetworkRequest {
  url: string;
  method?: string;
  headers?: Readonly<Record<string, string>>;
  body?: Uint8Array;
  signal?: AbortSignal;
}

export interface HostNetworkResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export interface HostNetworkBridge {
  request(request: HostNetworkRequest): Promise<HostNetworkResponse>;
}

/**
 * Workspace bytes are an opaque project bundle. The host may read them from a
 * file, browser download, native picker, or remote service without
 * understanding VFS or Agent semantics.
 */
export interface HostWorkspaceBridge {
  importWorkspace?(): Promise<Uint8Array | undefined>;
  exportWorkspace?(data: Uint8Array): Promise<void>;
  pickWorkspace?(): Promise<Uint8Array | undefined>;
}

export interface HostBridge {
  descriptor: HostDescriptor;
  storage?: HostStorage;
  clock?: HostClock;
  scheduler?: HostScheduler;
  crypto?: HostCrypto;
  clone?: HostClone;
  workspace?: HostWorkspaceBridge;
  terminal?: HostTerminal;
  process?: HostProcessBridge;
  network?: HostNetworkBridge;
  pty?: HostProcessBridge;
}

export interface HostCapabilityDiagnostic {
  capability: HostCapability | string;
  severity: 'error' | 'warning';
  code:
    | 'HOST_CAPABILITY_MISSING'
    | 'HOST_CAPABILITY_UNDECLARED'
    | 'HOST_CAPABILITY_UNKNOWN'
    | 'HOST_CAPABILITY_DUPLICATE'
    | 'HOST_DESCRIPTOR_INVALID';
  message: string;
}

export interface HostCapabilityReport {
  declared: HostCapability[];
  available: HostCapability[];
  diagnostics: HostCapabilityDiagnostic[];
  healthy: boolean;
}
