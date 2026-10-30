import type { JsonValue } from './types';

export interface WorkspaceLease {
  leaseId: string;
  sessionId: string;
  workspaceRoot: string;
  fencingToken: number;
  createdAt: number;
  expiresAt: number;
  readOnly: boolean;
}

export interface SandboxFile {
  path: string;
  data: Uint8Array;
  mode?: number;
  modifiedAt: number;
}

export interface ExecRequest {
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface SandboxCheckpoint {
  checkpointId: string;
  files: SandboxFile[];
  createdAt: number;
}

export interface PtyOpenRequest {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
  signal?: AbortSignal;
}

export type PtyEvent =
  | { type: 'data'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'exit'; exitCode: number };

export interface PtySession {
  id: string;
  write(data: string, signal?: AbortSignal): Promise<void>;
  resize(cols: number, rows: number): Promise<void>;
  read(timeoutMs?: number, signal?: AbortSignal): Promise<PtyEvent[]>;
  onEvent(listener: (event: PtyEvent) => void): () => void;
  close(): Promise<void>;
}

export interface SandboxProvider {
  createWorkspace(
    request: {
      sessionId: string;
      workspaceRoot?: string;
      readOnly?: boolean;
      ttlMs?: number;
      budget?: Record<string, number>;
    },
    signal?: AbortSignal
  ): Promise<WorkspaceLease>;
  readFile(lease: WorkspaceLease, path: string, signal?: AbortSignal): Promise<SandboxFile>;
  writeFile(
    lease: WorkspaceLease,
    path: string,
    data: Uint8Array,
    options?: { idempotencyKey?: string; signal?: AbortSignal }
  ): Promise<SandboxFile>;
  listFiles(lease: WorkspaceLease, path?: string, signal?: AbortSignal): Promise<SandboxFile[]>;
  deleteFile(
    lease: WorkspaceLease,
    path: string,
    options?: { idempotencyKey?: string; signal?: AbortSignal }
  ): Promise<boolean>;
  exec(lease: WorkspaceLease, request: ExecRequest): Promise<ExecResult>;
  checkpoint(lease: WorkspaceLease, signal?: AbortSignal): Promise<SandboxCheckpoint>;
  restore(
    lease: WorkspaceLease,
    checkpointId: string,
    signal?: AbortSignal
  ): Promise<void>;
  release(lease: WorkspaceLease): Promise<void>;
  openPty?(lease: WorkspaceLease, request: PtyOpenRequest): Promise<PtySession>;
}

export function sandboxJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
