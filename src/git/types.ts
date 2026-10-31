import type { JsonValue } from '../core/types';

export interface GitFileInfo {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  modifiedAt: number;
  mode: number;
  version: number;
}

export interface GitFileSystem {
  read(path: string, options?: { offset?: number; length?: number; signal?: AbortSignal }): Promise<Uint8Array>;
  write(
    path: string,
    data: Uint8Array,
    options?: {
      signal?: AbortSignal;
      expectedVersion?: number;
      mode?: number;
    }
  ): Promise<GitFileInfo>;
  list(
    path?: string,
    options?: { recursive?: boolean; signal?: AbortSignal }
  ): Promise<GitFileInfo[]>;
  stat(path: string, signal?: AbortSignal): Promise<GitFileInfo | undefined>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  copy(from: string, to: string): Promise<void>;
}

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Uint8Array;
}

export interface GitTreeEntry {
  mode: number;
  name: string;
  oid: string;
}

export interface GitSignature {
  name: string;
  email: string;
  timestamp: number;
  timezone: string;
}

export interface GitCommitInfo {
  oid: string;
  tree: string;
  parents: string[];
  author: GitSignature;
  committer: GitSignature;
  message: string;
}

export type GitFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'conflicted';

export interface GitStatusEntry {
  path: string;
  oldPath?: string;
  index: GitFileStatus | null;
  worktree: GitFileStatus | null;
  staged: boolean;
  untracked: boolean;
  ignored: boolean;
  stage?: number;
}

export interface GitStatus {
  branch: string | null;
  head: string | null;
  detached: boolean;
  clean: boolean;
  staged: GitStatusEntry[];
  unstaged: GitStatusEntry[];
  untracked: string[];
  ignored: string[];
  conflicted: GitStatusEntry[];
}

export interface GitDiffFile {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'binary' | 'renamed';
  patch?: string;
  binary?: boolean;
  truncated?: boolean;
}

export interface GitDiff {
  from: string;
  to: string;
  files: GitDiffFile[];
}

export interface GitCommitResult {
  oid: string;
  tree: string;
  parent?: string;
  branch: string | null;
}

export interface GitIndexEntry {
  path: string;
  oid: string;
  mode: number;
  stage: number;
  ctimeSeconds: number;
  ctimeNanos: number;
  mtimeSeconds: number;
  mtimeNanos: number;
  dev: number;
  ino: number;
  uid: number;
  gid: number;
  size: number;
  flags: number;
}

export interface GitCommitInput {
  message: string;
  author?: Partial<GitSignature>;
  committer?: Partial<GitSignature>;
  allowEmpty?: boolean;
}

export interface GitRepositoryInfo {
  gitDir: string;
  head: string | null;
  branch: string | null;
  objectFormat: 'sha1';
}

export interface GitBackend {
  init(options?: { initialBranch?: string }): Promise<GitRepositoryInfo>;
  repository(): Promise<GitRepositoryInfo | undefined>;
  status(signal?: AbortSignal): Promise<GitStatus>;
  add(paths: readonly string[], signal?: AbortSignal): Promise<void>;
  commit(input: GitCommitInput, signal?: AbortSignal): Promise<GitCommitResult>;
  log(options?: { maxCount?: number; revision?: string }, signal?: AbortSignal): Promise<GitCommitInfo[]>;
  show(revision: string, signal?: AbortSignal): Promise<JsonValue>;
  diff(
    options?: { from?: string; to?: string; staged?: boolean },
    signal?: AbortSignal
  ): Promise<GitDiff>;
  branches(signal?: AbortSignal): Promise<{ current: string | null; names: string[] }>;
  createBranch(name: string, signal?: AbortSignal): Promise<void>;
  deleteBranch(name: string, signal?: AbortSignal): Promise<void>;
  checkout(target: string, signal?: AbortSignal): Promise<void>;
  revParse(revision: string, signal?: AbortSignal): Promise<string>;
  exportRepository?(): Promise<Uint8Array>;
  importRepository?(data: Uint8Array, signal?: AbortSignal): Promise<void>;
}

export interface GitBackendDescriptor {
  kind: 'portable' | 'cli';
  version: string;
  limitations: string[];
}

export interface GitLimitations {
  objectFormat: 'sha1';
  features: string[];
}
