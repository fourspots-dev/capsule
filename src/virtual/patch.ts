import { AgentError } from '../core/errors';
import { normalizeVirtualPath } from './path';
import { decodeVirtualText, hashVirtualBytes } from './search';
import type { VirtualFileSystem } from './types';

export interface VirtualPatchOptions {
  expectedVersions?: Readonly<Record<string, number>>;
  expectedHashes?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface VirtualPatchResult {
  files: Array<{
    path: string;
    status: 'added' | 'modified' | 'deleted';
    beforeVersion: number;
    afterVersion: number;
  }>;
  additions: number;
  deletions: number;
}

type HunkLine =
  | { kind: 'context'; text: string }
  | { kind: 'add'; text: string }
  | { kind: 'remove'; text: string };

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: HunkLine[];
}

interface FilePatch {
  oldPath?: string;
  newPath?: string;
  hunks: Hunk[];
}

interface OriginalFile {
  path: string;
  existed: boolean;
  data?: Uint8Array;
  mode?: number;
  version: number;
}

export async function applyUnifiedPatch(
  vfs: VirtualFileSystem,
  patch: string,
  options: VirtualPatchOptions = {}
): Promise<VirtualPatchResult> {
  const parsed = parseUnifiedPatch(patch);
  const originals = new Map<string, OriginalFile>();
  const writes = new Map<string, { data: Uint8Array; mode?: number }>();
  const deletes = new Set<string>();
  let additions = 0;
  let deletions = 0;

  for (const file of parsed) {
    if (options.signal?.aborted) throw cancelled();
    const oldPath = file.oldPath;
    const newPath = file.newPath;
    const target = newPath ?? oldPath!;
    if (!oldPath && newPath && (await vfs.stat(newPath, options.signal))) {
      throw new AgentError('PATCH_TARGET_EXISTS', `Patch target already exists: ${newPath}`);
    }
    const before =
      oldPath === undefined
        ? new Uint8Array()
        : await vfs.read(oldPath, { signal: options.signal });
    const beforeInfo = oldPath ? await vfs.stat(oldPath, options.signal) : undefined;
    if (oldPath && !beforeInfo) {
      throw new AgentError('PATCH_FILE_MISSING', `Patch target is missing: ${oldPath}`);
    }
    if (beforeInfo && oldPath && options.expectedVersions?.[oldPath] !== undefined) {
      if (beforeInfo.version !== options.expectedVersions[oldPath]) {
        throw conflict(oldPath, 'version');
      }
    }
    if (beforeInfo && oldPath && options.expectedHashes?.[oldPath]) {
      if (hashVirtualBytes(before) !== options.expectedHashes[oldPath]) {
        throw conflict(oldPath, 'hash');
      }
    }
    const beforeText = decodeVirtualText(before);
    if (beforeText === undefined) {
      throw new AgentError('PATCH_BINARY_UNSUPPORTED', `Binary patch is not supported: ${oldPath}`);
    }
    const applied = applyHunks(beforeText, file.hunks);
    additions += applied.additions;
    deletions += applied.deletions;
    const oldOriginal = oldPath ? await remember(vfs, oldPath, originals) : undefined;
    const newOriginal = await remember(vfs, target, originals);
    if (oldPath === target && !oldOriginal?.existed && !newOriginal?.existed) {
      originals.set(target, { path: target, existed: false, version: 0 });
    }
    if (newPath) {
      writes.set(target, {
        data: new TextEncoder().encode(applied.text),
        ...(oldOriginal?.mode === undefined ? {} : { mode: oldOriginal.mode }),
      });
    } else {
      deletes.add(target);
    }
    if (oldPath && newPath && oldPath !== newPath) deletes.add(oldPath);
  }

  try {
    for (const [path, write] of writes) {
      await vfs.write(path, write.data, {
        ...(write.mode === undefined ? {} : { mode: write.mode }),
        signal: options.signal,
      });
    }
    for (const path of deletes) {
      await vfs.remove(path, { recursive: true });
    }
  } catch (error) {
    await rollback(vfs, originals);
    throw error;
  }

  const resultFiles: VirtualPatchResult['files'] = [];
  for (const file of parsed) {
    const path = file.newPath ?? file.oldPath!;
    const original = originals.get(path);
    const after = file.newPath ? await vfs.stat(path) : undefined;
    resultFiles.push({
      path,
      status: !file.oldPath
        ? 'added'
        : !file.newPath
          ? 'deleted'
          : 'modified',
      beforeVersion: original?.existed ? original.version : 0,
      afterVersion: after?.version ?? 0,
    });
  }
  return { files: resultFiles, additions, deletions };
}

export function parseUnifiedPatch(patch: string): FilePatch[] {
  const lines = patch.replaceAll('\r\n', '\n').split('\n');
  const files: FilePatch[] = [];
  let current: FilePatch | undefined;
  let hunk: Hunk | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('--- ')) {
      if (current) {
        if (hunk) current.hunks.push(hunk);
        files.push(current);
      }
      const oldPath = parseHeaderPath(line.slice(4));
      const next = lines[index + 1];
      if (!next?.startsWith('+++ ')) {
        throw invalid('Patch file header must be followed by +++');
      }
      current = {
        ...(oldPath ? { oldPath } : {}),
        newPath: parseHeaderPath(next.slice(4)) ?? undefined,
        hunks: [],
      };
      hunk = undefined;
      index += 1;
      continue;
    }
    if (!current) {
      if (!line.trim()) continue;
      throw invalid('Patch must start with a file header');
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      if (hunk) current.hunks.push(hunk);
      hunk = {
        oldStart: Number(match[1]),
        oldCount: Number(match[2] ?? 1),
        newStart: Number(match[3]),
        newCount: Number(match[4] ?? 1),
        lines: [],
      };
      continue;
    }
    if (line.startsWith('\\ No newline at end of file')) continue;
    if (!hunk) continue;
    if (line.startsWith('+')) hunk.lines.push({ kind: 'add', text: line.slice(1) });
    else if (line.startsWith('-')) hunk.lines.push({ kind: 'remove', text: line.slice(1) });
    else if (line.startsWith(' ')) hunk.lines.push({ kind: 'context', text: line.slice(1) });
    else if (line !== '') throw invalid(`Unknown patch line: ${line.slice(0, 20)}`);
  }
  if (current) {
    if (hunk) current.hunks.push(hunk);
    files.push(current);
  }
  if (!files.length) throw invalid('Patch contains no file changes');
  for (const file of files) {
    if (!file.hunks.length) throw invalid('Patch file contains no hunks');
    if (!file.oldPath && !file.newPath) throw invalid('Patch must identify a path');
  }
  return files;
}

function applyHunks(
  before: string,
  hunks: readonly Hunk[]
): { text: string; additions: number; deletions: number } {
  const lines = before ? before.split('\n') : [];
  const hadFinalNewline = before.endsWith('\n');
  if (hadFinalNewline) lines.pop();
  const output: string[] = [];
  let cursor = 0;
  let additions = 0;
  let deletions = 0;
  for (const hunk of hunks) {
    const start = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
    if (start < cursor || start > lines.length) throw invalid('Patch hunk overlaps or is out of range');
    output.push(...lines.slice(cursor, start));
    cursor = start;
    let oldSeen = 0;
    let newSeen = 0;
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        output.push(line.text);
        newSeen += 1;
        additions += 1;
      } else if (line.kind === 'remove') {
        if (lines[cursor] !== line.text) throw conflictLine(cursor + 1);
        cursor += 1;
        oldSeen += 1;
        deletions += 1;
      } else {
        if (lines[cursor] !== line.text) throw conflictLine(cursor + 1);
        output.push(line.text);
        cursor += 1;
        oldSeen += 1;
        newSeen += 1;
      }
    }
    if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
      throw invalid(
        `Patch hunk line counts do not match its header (old ${oldSeen}/${hunk.oldCount}, new ${newSeen}/${hunk.newCount})`
      );
    }
  }
  output.push(...lines.slice(cursor));
  return {
    text: `${output.join('\n')}${hadFinalNewline || before === '' ? '\n' : ''}`,
    additions,
    deletions,
  };
}

async function remember(
  vfs: VirtualFileSystem,
  path: string,
  originals: Map<string, OriginalFile>
): Promise<OriginalFile | undefined> {
  const existing = originals.get(path);
  if (existing) return existing;
  const info = await vfs.stat(path);
  const original: OriginalFile = info
    ? {
        path,
        existed: true,
        data: await vfs.read(path),
        mode: info.mode,
        version: info.version,
      }
    : { path, existed: false, version: 0 };
  originals.set(path, original);
  return original;
}

async function rollback(
  vfs: VirtualFileSystem,
  originals: Map<string, OriginalFile>
): Promise<void> {
  for (const original of originals.values()) {
    if (original.existed) {
      await vfs.write(original.path, original.data!, {
        ...(original.mode === undefined ? {} : { mode: original.mode }),
      });
    } else {
      await vfs.remove(original.path, { recursive: true });
    }
  }
}

function parseHeaderPath(value: string): string | undefined {
  const path = value.split('\t')[0].trim();
  if (!path || path === '/dev/null') return undefined;
  return normalizeVirtualPath(path.replace(/^[ab]\//, ''));
}

function conflict(path: string, kind: 'version' | 'hash'): AgentError {
  return new AgentError(
    'PATCH_CONFLICT',
    `Patch expected ${kind} does not match current file: ${path}`
  );
}

function conflictLine(line: number): AgentError {
  return new AgentError(
    'PATCH_CONTEXT_MISMATCH',
    `Patch context does not match at line ${line}`
  );
}

function invalid(message: string): AgentError {
  return new AgentError('PATCH_INVALID', message);
}

function cancelled(): AgentError {
  return new AgentError('PATCH_CANCELLED', 'Virtual patch was cancelled');
}
