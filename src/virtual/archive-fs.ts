import { AgentError } from '../core/errors';
import { MemoryFileSystem } from './memory-fs';
import { normalizeVirtualPath } from './path';
import type {
  VirtualFileInfo,
  VirtualFileSystem,
  VirtualFsEvent,
  VirtualListOptions,
  VirtualReadOptions,
  VirtualWriteOptions,
} from './types';

export const WORKSPACE_BUNDLE_FORMAT = 'tinyai.workspace.bundle';
export const WORKSPACE_BUNDLE_SCHEMA_VERSION = 1;

export interface WorkspaceBundleFile {
  path: string;
  dataBase64: string;
  mode?: number;
  modifiedAt?: number;
}

export interface WorkspaceBundle {
  format: typeof WORKSPACE_BUNDLE_FORMAT;
  schemaVersion: typeof WORKSPACE_BUNDLE_SCHEMA_VERSION;
  createdAt?: number;
  revision?: string;
  metadata?: Record<string, string>;
  directories: string[];
  files: WorkspaceBundleFile[];
}

/**
 * A read-only VFS backed by a portable project bundle. Importing a bundle does
 * not expose host paths; callers may wrap it in OverlayFS before editing.
 */
export class ArchiveFileSystem implements VirtualFileSystem {
  readonly bundle: WorkspaceBundle;
  private readonly source: MemoryFileSystem;
  private readonly loading: Promise<void>;

  constructor(bundle: WorkspaceBundle | Uint8Array, now: () => number = () => 0) {
    this.bundle = parseWorkspaceBundle(bundle);
    this.source = new MemoryFileSystem(now);
    this.loading = this.load();
  }

  async read(path: string, options: VirtualReadOptions = {}): Promise<Uint8Array> {
    await this.ready();
    return this.source.read(path, options);
  }

  async list(
    path = '',
    options: VirtualListOptions = {}
  ): Promise<VirtualFileInfo[]> {
    await this.ready();
    return this.source.list(path, options);
  }

  async stat(
    path: string,
    signal?: AbortSignal
  ): Promise<VirtualFileInfo | undefined> {
    await this.ready();
    return this.source.stat(path, signal);
  }

  async write(
    _path: string,
    _data: Uint8Array,
    _options: VirtualWriteOptions = {}
  ): Promise<VirtualFileInfo> {
    throw readOnly();
  }

  async mkdir(
    _path: string,
    _options: { recursive?: boolean } = {}
  ): Promise<void> {
    throw readOnly();
  }

  async remove(
    _path: string,
    _options: { recursive?: boolean } = {}
  ): Promise<boolean> {
    throw readOnly();
  }

  async rename(_from: string, _to: string): Promise<void> {
    throw readOnly();
  }

  async copy(_from: string, _to: string): Promise<void> {
    throw readOnly();
  }

  watch(_listener: (event: VirtualFsEvent) => void): () => void {
    return () => undefined;
  }

  exportBundle(): WorkspaceBundle {
    return cloneBundle(this.bundle);
  }

  private async load(): Promise<void> {
    for (const directory of this.bundle.directories) {
      await this.source.mkdir(directory, { recursive: true });
    }
    for (const file of this.bundle.files) {
      await this.source.write(
        file.path,
        base64ToBytes(file.dataBase64, file.path),
        { ...(file.mode === undefined ? {} : { mode: file.mode }) }
      );
    }
  }

  private async ready(): Promise<void> {
    await this.loading;
  }
}

export function createWorkspaceBundle(input: {
  files: WorkspaceBundleFile[];
  directories?: string[];
  createdAt?: number;
  revision?: string;
  metadata?: Record<string, string>;
}): WorkspaceBundle {
  return parseWorkspaceBundle({
    format: WORKSPACE_BUNDLE_FORMAT,
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    ...(input.revision ? { revision: input.revision } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    directories: input.directories ?? [],
    files: input.files,
  });
}

export function parseWorkspaceBundle(
  input: WorkspaceBundle | Uint8Array
): WorkspaceBundle {
  const value = input instanceof Uint8Array ? parseJson(input) : input;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidBundle('Bundle must be an object');
  }
  const candidate = value as Partial<WorkspaceBundle>;
  if (candidate.format !== WORKSPACE_BUNDLE_FORMAT) {
    throw invalidBundle(`Unsupported workspace bundle format: ${String(candidate.format)}`);
  }
  if (candidate.schemaVersion !== WORKSPACE_BUNDLE_SCHEMA_VERSION) {
    throw invalidBundle(
      `Unsupported workspace bundle schema: ${String(candidate.schemaVersion)}`
    );
  }
  if (!Array.isArray(candidate.files) || !Array.isArray(candidate.directories)) {
    throw invalidBundle('Bundle directories and files must be arrays');
  }
  const paths = new Set<string>();
  const directories = candidate.directories.map((directory) => {
    const normalized = normalizeVirtualPath(directory);
    if (!normalized) {
      throw invalidBundle('Bundle root directory is implicit');
    }
    if (paths.has(normalized)) {
      throw invalidBundle(`Duplicate bundle path: ${normalized}`);
    }
    paths.add(normalized);
    return normalized;
  });
  const files = candidate.files.map((file) => {
    if (!file || typeof file.path !== 'string' || typeof file.dataBase64 !== 'string') {
      throw invalidBundle('Bundle file entry is invalid');
    }
    const path = normalizeVirtualPath(file.path);
    if (!path) throw invalidBundle('Bundle file path cannot be empty');
    if (paths.has(path)) {
      throw invalidBundle(`Duplicate bundle path: ${path}`);
    }
    paths.add(path);
    const mode =
      file.mode === undefined
        ? undefined
        : Number.isInteger(file.mode) && file.mode >= 0
          ? file.mode
          : invalidBundle(`Invalid file mode: ${path}`);
    base64ToBytes(file.dataBase64, path);
    return {
      path,
      dataBase64: file.dataBase64,
      ...(mode === undefined ? {} : { mode }),
      ...(Number.isFinite(file.modifiedAt)
        ? { modifiedAt: Number(file.modifiedAt) }
        : {}),
    };
  });
  validateBundleHierarchy(directories, files);
  return {
    format: WORKSPACE_BUNDLE_FORMAT,
    schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
    ...(Number.isFinite(candidate.createdAt)
      ? { createdAt: Number(candidate.createdAt) }
      : {}),
    ...(typeof candidate.revision === 'string'
      ? { revision: candidate.revision }
      : {}),
    ...(candidate.metadata
      ? { metadata: sanitizeMetadata(candidate.metadata) }
      : {}),
    directories: [...new Set(directories)].sort(),
    files: files.sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function validateBundleHierarchy(
  directories: readonly string[],
  files: readonly WorkspaceBundleFile[]
): void {
  const directorySet = new Set(directories);
  const fileSet = new Set(files.map((file) => file.path));
  for (const path of fileSet) {
    let parent = parentPath(path);
    while (parent) {
      if (fileSet.has(parent)) {
        throw invalidBundle(`Bundle file cannot contain another path: ${parent}`);
      }
      parent = parentPath(parent);
    }
  }
  for (const path of directorySet) {
    let parent = parentPath(path);
    while (parent) {
      if (fileSet.has(parent)) {
        throw invalidBundle(`Bundle file cannot contain another path: ${parent}`);
      }
      parent = parentPath(parent);
    }
  }
}

function parentPath(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function serializeWorkspaceBundle(bundle: WorkspaceBundle): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(parseWorkspaceBundle(bundle)));
}

export function cloneBundle(bundle: WorkspaceBundle): WorkspaceBundle {
  return {
    ...bundle,
    ...(bundle.metadata ? { metadata: { ...bundle.metadata } } : {}),
    directories: [...bundle.directories],
    files: bundle.files.map((file) => ({ ...file })),
  };
}

function parseJson(value: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(value));
  } catch {
    throw invalidBundle('Workspace bundle is not valid JSON');
  }
}

function sanitizeMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidBundle('Bundle metadata must be an object');
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw invalidBundle(`Bundle metadata value must be a string: ${key}`);
    }
    result[key] = item;
  }
  return result;
}

function base64ToBytes(value: string, path: string): Uint8Array {
  try {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index);
    }
    return result;
  } catch {
    throw invalidBundle(`Invalid base64 data: ${path}`);
  }
}

function readOnly(): AgentError {
  return new AgentError('VFS_READ_ONLY', 'Archive workspace is read-only');
}

function invalidBundle(message: string): never {
  throw new AgentError('VFS_BUNDLE_INVALID', message);
}
