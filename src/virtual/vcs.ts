import { AgentError } from '../core/errors';
import { OverlayFileSystem } from './overlay-fs';
import type { VirtualKeyValueStore } from './persistent-fs';
import type {
  VirtualChangeSet,
  VirtualFileSystem,
} from './types';

export interface SnapshotRecord {
  id: string;
  parentId?: string;
  label?: string;
  createdAt: number;
  files: Record<
    string,
    {
      objectId: string;
      mode: number;
      version: number;
    }
  >;
}

export interface SnapshotSummary {
  id: string;
  parentId?: string;
  label?: string;
  createdAt: number;
  fileCount: number;
}

export interface SnapshotDiff {
  from: string;
  to: string;
  files: Array<{
    path: string;
    status: 'added' | 'deleted' | 'modified' | 'binary';
    patch?: string;
  }>;
}

export class SnapshotVcs {
  private readonly snapshots = new Map<string, SnapshotRecord>();
  private readonly objects = new Map<string, Uint8Array>();
  private readonly storage?: VirtualKeyValueStore;
  private readonly storageKey: string;
  private sequence = 0;
  private head?: string;
  private initialized?: Promise<void>;

  constructor(
    private readonly vfs: VirtualFileSystem,
    private readonly now: () => number = () => Date.now(),
    options: {
      storage?: VirtualKeyValueStore;
      storageKey?: string;
    } = {}
  ) {
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? 'tinyai:vcs:v1';
  }

  get headId(): string | undefined {
    return this.head;
  }

  async commit(label?: string): Promise<SnapshotSummary> {
    await this.initialize();
    const files: SnapshotRecord['files'] = {};
    for (const item of await this.vfs.list('', { recursive: true })) {
      if (item.kind !== 'file') continue;
      const data = await this.vfs.read(item.path);
      const hash = hashBytes(data);
      let objectId = hash;
      let collision = 1;
      while (this.objects.has(objectId) && !bytesEqual(this.objects.get(objectId)!, data)) {
        objectId = `${hash}-${++collision}`;
      }
      this.objects.set(objectId, new Uint8Array(data));
      files[item.path] = {
        objectId,
        mode: item.mode,
        version: item.version,
      };
    }
    const id = `snapshot_${++this.sequence}`;
    const snapshot: SnapshotRecord = {
      id,
      ...(this.head ? { parentId: this.head } : {}),
      ...(label?.trim() ? { label: label.trim() } : {}),
      createdAt: this.now(),
      files,
    };
    this.snapshots.set(id, snapshot);
    this.head = id;
    await this.persist();
    return summarize(snapshot);
  }

  async diff(fromId?: string, toId = this.head): Promise<SnapshotDiff> {
    await this.initialize();
    if (!toId) throw new AgentError('VCS_NO_HEAD', 'No snapshot is available');
    const to = this.required(toId);
    const from = fromId
      ? this.required(fromId)
      : to.parentId
        ? this.required(to.parentId)
        : undefined;
    const paths = new Set([
      ...Object.keys(from?.files ?? {}),
      ...Object.keys(to.files),
    ]);
    const files: SnapshotDiff['files'] = [];
    for (const path of [...paths].sort()) {
      const before = from?.files[path];
      const after = to.files[path];
      if (!before) {
        files.push({
          path,
          status: 'added',
          ...textPatch(new Uint8Array(), this.object(after.objectId), path),
        });
        continue;
      }
      if (!after) {
        files.push({
          path,
          status: 'deleted',
          ...textPatch(this.object(before.objectId), new Uint8Array(), path),
        });
        continue;
      }
      if (before.objectId === after.objectId) continue;
      const beforeData = this.object(before.objectId);
      const afterData = this.object(after.objectId);
      const patch = textPatch(beforeData, afterData, path);
      files.push({ path, status: patch.patch ? 'modified' : 'binary', ...patch });
    }
    return {
      from: from?.id ?? 'empty',
      to: to.id,
      files,
    };
  }

  async restore(snapshotId: string): Promise<void> {
    await this.initialize();
    const snapshot = this.required(snapshotId);
    const existing = await this.vfs.list('', { recursive: true });
    for (const item of existing.sort((a, b) => b.path.length - a.path.length)) {
      if (item.kind === 'file') await this.vfs.remove(item.path);
      else await this.vfs.remove(item.path, { recursive: true });
    }
    for (const [path, file] of Object.entries(snapshot.files)) {
      await this.vfs.write(path, this.object(file.objectId), { mode: file.mode });
    }
    this.head = snapshot.id;
    await this.persist();
  }

  fork(): OverlayFileSystem {
    return new OverlayFileSystem(this.vfs, this.now);
  }

  async applyChanges(changes: VirtualChangeSet): Promise<void> {
    await this.initialize();
    for (const file of changes.written) {
      await this.vfs.write(file.path, file.data, { mode: file.mode });
    }
    for (const path of changes.deleted) {
      await this.vfs.remove(path, { recursive: true });
    }
    await this.persist();
  }

  async list(): Promise<SnapshotSummary[]> {
    await this.initialize();
    return [...this.snapshots.values()].map(summarize);
  }

  async initialize(): Promise<void> {
    this.initialized ??= this.load();
    await this.initialized;
  }

  private object(id: string): Uint8Array {
    const data = this.objects.get(id);
    if (!data) throw new AgentError('VCS_OBJECT_MISSING', `Snapshot object missing: ${id}`);
    return data;
  }

  private required(id: string): SnapshotRecord {
    const snapshot = this.snapshots.get(id);
    if (!snapshot) throw new AgentError('VCS_SNAPSHOT_NOT_FOUND', `Snapshot not found: ${id}`);
    return snapshot;
  }

  private async load(): Promise<void> {
    const raw = await this.storage?.get(this.storageKey);
    if (!raw) return;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      (raw as PersistedVcs).schemaVersion !== 1 ||
      !Array.isArray((raw as PersistedVcs).snapshots) ||
      !(raw as PersistedVcs).objects ||
      typeof (raw as PersistedVcs).objects !== 'object'
    ) {
      throw new AgentError('VCS_STATE_INVALID', 'Persisted VCS state is invalid');
    }
    const state = raw as PersistedVcs;
    this.sequence = Math.max(0, Number(state.sequence) || 0);
    this.head = state.head;
    for (const snapshot of state.snapshots) this.snapshots.set(snapshot.id, snapshot);
    for (const [id, encoded] of Object.entries(state.objects)) {
      this.objects.set(id, base64ToBytes(encoded));
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedVcs = {
      schemaVersion: 1,
      sequence: this.sequence,
      ...(this.head ? { head: this.head } : {}),
      snapshots: [...this.snapshots.values()].map((snapshot) => ({
        ...snapshot,
        files: Object.fromEntries(
          Object.entries(snapshot.files).map(([path, file]) => [path, { ...file }])
        ),
      })),
      objects: Object.fromEntries(
        [...this.objects].map(([id, data]) => [id, bytesToBase64(data)])
      ),
    };
    await this.storage.set(this.storageKey, state);
  }
}

interface PersistedVcs {
  schemaVersion: 1;
  sequence: number;
  head?: string;
  snapshots: SnapshotRecord[];
  objects: Record<string, string>;
}

export function unifiedDiff(
  before: Uint8Array,
  after: Uint8Array,
  path: string
): { patch?: string; status: 'modified' | 'binary' } {
  const beforeText = decodeText(before);
  const afterText = decodeText(after);
  if (beforeText === undefined || afterText === undefined) return { status: 'binary' };
  return { patch: buildPatch(beforeText, afterText, path), status: 'modified' };
}

function summarize(snapshot: SnapshotRecord): SnapshotSummary {
  return {
    id: snapshot.id,
    ...(snapshot.parentId ? { parentId: snapshot.parentId } : {}),
    ...(snapshot.label ? { label: snapshot.label } : {}),
    createdAt: snapshot.createdAt,
    fileCount: Object.keys(snapshot.files).length,
  };
}

function textPatch(
  before: Uint8Array,
  after: Uint8Array,
  path: string
): { patch?: string } {
  return unifiedDiff(before, after, path).patch
    ? { patch: unifiedDiff(before, after, path).patch }
    : {};
}

function buildPatch(before: string, after: string, path: string): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const lcs = longestCommonSubsequence(oldLines, newLines);
  if (lcs === oldLines.length && lcs === newLines.length) return '';
  const lines = [`--- a/${path}`, `+++ b/${path}`, `@@ -1,${oldLines.length} +1,${newLines.length} @@`];
  let oldIndex = 0;
  let newIndex = 0;
  for (const [commonOld, commonNew] of commonPairs(oldLines, newLines)) {
    while (oldIndex < commonOld) lines.push(`-${oldLines[oldIndex++]}`);
    while (newIndex < commonNew) lines.push(`+${newLines[newIndex++]}`);
    lines.push(` ${oldLines[oldIndex]}`);
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldLines.length) lines.push(`-${oldLines[oldIndex++]}`);
  while (newIndex < newLines.length) lines.push(`+${newLines[newIndex++]}`);
  return `${lines.join('\n')}\n`;
}

function longestCommonSubsequence(left: string[], right: string[]): number {
  const previous = new Array(right.length + 1).fill(0);
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1).fill(0);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        left[i - 1] === right[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function commonPairs(left: string[], right: string[]): Array<[number, number]> {
  const dp = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      dp[i][j] =
        left[i] === right[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const result: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      result.push([i, j]);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i += 1;
    else j += 1;
  }
  return result;
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function decodeText(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function hashBytes(value: Uint8Array): string {
  let hash = 1469598103934665603n;
  for (const byte of value) {
    hash ^= BigInt(byte);
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return `${value.byteLength.toString(16)}-${hash.toString(16).padStart(16, '0')}`;
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((byte, index) => byte === right[index]);
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}
