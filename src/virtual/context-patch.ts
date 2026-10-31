import { AgentError } from '../core/errors';
import type { JsonValue } from '../core/types';
import type { PatchFileSystem } from './patch-port';
import { normalizeVirtualPath } from './path';
import { decodeVirtualText, hashVirtualBytes } from './search';
import type { VirtualFileInfo } from './types';
import { unifiedDiff } from './vcs';

export type ContextPatchLineKind = 'context' | 'add' | 'remove';

export interface ContextPatchLine {
  kind: ContextPatchLineKind;
  text: string;
}

export interface ContextHunk {
  anchor?: string;
  lines: ContextPatchLine[];
  endOfFile?: boolean;
}

export type ContextPatchOperation =
  | {
      kind: 'update';
      path: string;
      moveTo?: string;
      hunks: ContextHunk[];
    }
  | {
      kind: 'add';
      path: string;
      lines: string[];
    }
  | {
      kind: 'delete';
      path: string;
    };

export interface ContextPatch {
  operations: ContextPatchOperation[];
}

export interface ContextPatchOptions {
  expectedVersions?: Readonly<Record<string, number>>;
  expectedHashes?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface ContextPatchResult {
  protocolVersion: 1;
  files: Array<{
    path: string;
    oldPath?: string;
    status: 'added' | 'modified' | 'deleted' | 'moved';
    beforeVersion: number;
    afterVersion: number;
  }>;
  unifiedDiff: string;
  additions: number;
  deletions: number;
}

interface OriginalFile {
  path: string;
  existed: boolean;
  data?: Uint8Array;
  mode?: number;
  version: number;
}

interface PreparedFile {
  operation: ContextPatchOperation;
  path: string;
  oldPath?: string;
  before: OriginalFile;
  after?: {
    data: Uint8Array;
    mode?: number;
  };
  additions: number;
  deletions: number;
}

export function parseContextPatch(source: string): ContextPatch {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '*** Begin Patch') {
    if (lines.some((line) => line.startsWith('--- '))) {
      throw invalid(
        'apply_patch accepts ContextPatch, not a raw unified diff; use apply_unified_diff instead',
        { suggestion: 'Use *** Begin Patch / *** End Patch or apply_unified_diff' }
      );
    }
    throw invalid('Patch must start with *** Begin Patch');
  }

  const operations: ContextPatchOperation[] = [];
  let operation: ContextPatchOperation | undefined;
  let hunk: ContextHunk | undefined;
  let ended = false;

  const finishHunk = () => {
    if (!operation || operation.kind !== 'update' || !hunk) return;
    if (!hunk.lines.length && !hunk.endOfFile) {
      throw invalid('Update hunk must contain context, remove or add lines');
    }
    operation.hunks.push(hunk);
    hunk = undefined;
  };
  const finishOperation = () => {
    finishHunk();
    if (!operation) return;
    if (
      operation.kind === 'update' &&
      !operation.hunks.length &&
      !operation.moveTo
    ) {
      throw invalid(`Update File requires a hunk or Move to: ${operation.path}`);
    }
    operations.push(operation);
    operation = undefined;
  };

  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '*** Begin Patch') {
      throw invalid(`Nested *** Begin Patch at line ${index + 1}`);
    }
    if (line === '*** End Patch') {
      if (ended) throw invalid('Patch contains multiple *** End Patch markers');
      finishOperation();
      ended = true;
      if (lines.slice(index + 1).some((remaining) => remaining.trim())) {
        throw invalid('Content found after *** End Patch');
      }
      break;
    }
    if (ended) continue;
    if (line.startsWith('*** Update File: ')) {
      finishOperation();
      operation = {
        kind: 'update',
        path: safePath(line.slice('*** Update File: '.length), index),
        hunks: [],
      };
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      finishOperation();
      operation = {
        kind: 'add',
        path: safePath(line.slice('*** Add File: '.length), index),
        lines: [],
      };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      finishOperation();
      operation = {
        kind: 'delete',
        path: safePath(line.slice('*** Delete File: '.length), index),
      };
      continue;
    }
    if (line.startsWith('*** Move to: ')) {
      if (!operation || operation.kind !== 'update') {
        throw invalid(`Move to must follow Update File at line ${index + 1}`);
      }
      if (operation.moveTo) {
        throw invalid(`Update File contains multiple Move to directives: ${operation.path}`);
      }
      operation.moveTo = safePath(
        line.slice('*** Move to: '.length),
        index
      );
      continue;
    }
    if (line === '*** End of File') {
      if (!operation || operation.kind !== 'update' || !hunk) {
        throw invalid(`End of File must close an update hunk at line ${index + 1}`);
      }
      hunk.endOfFile = true;
      finishHunk();
      continue;
    }
    if (!operation) {
      if (!line.trim()) continue;
      throw invalid(`Unknown patch directive at line ${index + 1}: ${line.slice(0, 40)}`);
    }
    if (operation.kind === 'add') {
      if (line === '') {
        continue;
      }
      if (line.startsWith('+')) {
        operation.lines.push(line.slice(1));
      } else {
        throw invalid(`Add File line must start with '+': line ${index + 1}`);
      }
      continue;
    }
    if (operation.kind === 'delete') {
      if (line.trim()) {
        throw invalid(`Delete File does not accept content: line ${index + 1}`);
      }
      continue;
    }
    if (line.startsWith('@@')) {
      if (/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(line)) {
        throw invalid(
          'ContextPatch hunks must not contain unified-diff line counts; use @@ or @@ anchor',
          { suggestion: 'Remove line numbers, or use apply_unified_diff' }
        );
      }
      finishHunk();
      hunk = {
        ...(line.slice(2).trim() ? { anchor: line.slice(2).trim() } : {}),
        lines: [],
      };
      continue;
    }
    if (!hunk) {
      if (!line.trim()) continue;
      throw invalid(`Update File content must follow @@: line ${index + 1}`);
    }
    if (
      line === '' &&
      (lines.slice(index + 1).find((candidate) => candidate.trim())?.startsWith(
        '***'
      ) ||
        lines.slice(index + 1).find((candidate) => candidate.trim())?.startsWith(
          '@@'
        ))
    ) {
      continue;
    }
    if (line.startsWith(' ')) {
      hunk.lines.push({ kind: 'context', text: line.slice(1) });
    } else if (line.startsWith('-')) {
      hunk.lines.push({ kind: 'remove', text: line.slice(1) });
    } else if (line.startsWith('+')) {
      hunk.lines.push({ kind: 'add', text: line.slice(1) });
    } else if (line === '') {
      hunk.lines.push({ kind: 'context', text: '' });
    } else {
      throw invalid(`Unknown patch line at ${index + 1}: ${line.slice(0, 40)}`);
    }
  }

  if (!ended) throw invalid('Patch is missing *** End Patch');
  if (!operations.length) throw invalid('Patch contains no file operations');
  return { operations };
}

export async function applyContextPatch(
  vfs: PatchFileSystem,
  source: string,
  options: ContextPatchOptions = {}
): Promise<ContextPatchResult> {
  const patch = parseContextPatch(source);
  const originals = new Map<string, OriginalFile>();
  const claimedPaths = new Set<string>();
  const prepared: PreparedFile[] = [];

  for (const [operationIndex, operation] of patch.operations.entries()) {
    if (options.signal?.aborted) throw cancelled();
    if (claimedPaths.has(operation.path)) {
      throw invalid(`Patch operates on the same path more than once: ${operation.path}`, {
        operation: operationIndex,
        path: operation.path,
      });
    }
    claimedPaths.add(operation.path);
    const beforeInfo = await vfs.stat(operation.path, options.signal);
    const before = await remember(vfs, operation.path, originals);
    assertExpected(operation.path, beforeInfo, before, options, operationIndex);

    if (operation.kind === 'add') {
      if (beforeInfo) {
        throw error(
          'PATCH_TARGET_EXISTS',
          `Patch target already exists: ${operation.path}`,
          { operation: operationIndex, path: operation.path, suggestion: 'Use Update File or choose a new path' }
        );
      }
      const text = operation.lines.length ? `${operation.lines.join('\n')}\n` : '';
      prepared.push({
        operation,
        path: operation.path,
        before,
        after: { data: new TextEncoder().encode(text) },
        additions: operation.lines.length,
        deletions: 0,
      });
      continue;
    }

    if (!beforeInfo || beforeInfo.kind !== 'file') {
      throw error(
        'PATCH_FILE_MISSING',
        `Patch target is missing or not a file: ${operation.path}`,
        { operation: operationIndex, path: operation.path }
      );
    }

    if (operation.kind === 'delete') {
      prepared.push({
        operation,
        path: operation.path,
        before,
        additions: 0,
        deletions: textLineCount(before.data),
      });
      continue;
    }

    const targetPath = operation.moveTo
      ? safeOperationPath(operation.moveTo, operationIndex)
      : operation.path;
    if (operation.moveTo) {
      if (claimedPaths.has(targetPath)) {
        throw invalid(`Move target is used more than once: ${targetPath}`, {
          operation: operationIndex,
          path: targetPath,
        });
      }
      claimedPaths.add(targetPath);
      if (await vfs.stat(targetPath, options.signal)) {
        throw error(
          'PATCH_TARGET_EXISTS',
          `Move target already exists: ${targetPath}`,
          { operation: operationIndex, path: targetPath, suggestion: 'Delete or move the target first' }
        );
      }
      await remember(vfs, targetPath, originals);
    }

    const beforeText = decodeVirtualText(before.data!);
    if (beforeText === undefined) {
      throw error(
        'PATCH_BINARY_UNSUPPORTED',
        `ContextPatch cannot edit binary files: ${operation.path}`,
        { operation: operationIndex, path: operation.path }
      );
    }
    const applied = applyContextHunks(
      beforeText,
      operation.hunks,
      operation.path,
      operationIndex
    );
    prepared.push({
      operation,
      path: targetPath,
      oldPath: operation.path,
      before,
      after: {
        data: new TextEncoder().encode(applied.text),
        ...(before.mode === undefined ? {} : { mode: before.mode }),
      },
      additions: applied.additions,
      deletions: applied.deletions,
    });
  }

  const writes = prepared.filter(
    (item): item is PreparedFile & { after: NonNullable<PreparedFile['after']> } =>
      item.after !== undefined
  );
  const deletes = new Set(
    prepared
      .filter((item) => !item.after)
      .map((item) => item.path)
  );
  for (const item of prepared) {
    if (item.oldPath && item.oldPath !== item.path) deletes.add(item.oldPath);
  }

  try {
    for (const item of writes.sort((left, right) => left.path.localeCompare(right.path))) {
      await vfs.write(item.path, item.after.data, {
        ...(item.after.mode === undefined ? {} : { mode: item.after.mode }),
        signal: options.signal,
      });
    }
    for (const path of [...deletes].sort()) {
      await vfs.remove(path, { recursive: false });
    }
  } catch (failure) {
    await rollback(vfs, originals);
    throw failure;
  }

  const files: ContextPatchResult['files'] = [];
  const patchParts: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const item of prepared) {
    if (options.signal?.aborted) {
      await rollback(vfs, originals);
      throw cancelled();
    }
    additions += item.additions;
    deletions += item.deletions;
    const after = item.after ? await vfs.stat(item.path) : undefined;
    files.push({
      path: item.path,
      ...(item.oldPath && item.oldPath !== item.path
        ? { oldPath: item.oldPath }
        : {}),
      status:
        item.operation.kind === 'add'
          ? 'added'
          : item.operation.kind === 'delete'
            ? 'deleted'
            : item.oldPath && item.oldPath !== item.path
              ? 'moved'
              : 'modified',
      beforeVersion: item.before.existed ? item.before.version : 0,
      afterVersion: after?.version ?? 0,
    });
    patchParts.push(
      renderOperationDiff(
        item.operation,
        item.before.data,
        item.after?.data
      )
    );
  }
  return {
    protocolVersion: 1,
    files,
    unifiedDiff: patchParts.filter(Boolean).join('\n'),
    additions,
    deletions,
  };
}

function applyContextHunks(
  before: string,
  hunks: readonly ContextHunk[],
  path: string,
  operation: number
): { text: string; additions: number; deletions: number } {
  const usesCrlf = before.includes('\r\n');
  const normalized = usesCrlf ? before.replace(/\r\n/g, '\n') : before;
  const hadFinalNewline = normalized.endsWith('\n');
  let working = splitTextLines(normalized);
  let additions = 0;
  let deletions = 0;
  for (const [hunkIndex, hunk] of hunks.entries()) {
    const oldLines = hunk.lines
      .filter((line) => line.kind !== 'add')
      .map((line) => line.text);
    let candidates =
      oldLines.length === 0
        ? [working.length]
        : findLineSequence(working, oldLines);
    if (hunk.anchor) {
      const anchorLines = working
        .map((line, index) => (line.includes(hunk.anchor!) ? index : -1))
        .filter((index) => index >= 0);
      if (anchorLines.length === 0) {
        candidates = [];
      } else if (oldLines.length === 0) {
        candidates = anchorLines.map((index) => index + 1);
      } else {
        candidates = candidates.filter((start) =>
          anchorLines.some((anchorIndex) => anchorIndex <= start)
        );
      }
    }
    if (hunk.endOfFile) {
      candidates = candidates.filter(
        (start) => start + oldLines.length === working.length
      );
    }
    if (candidates.length === 0) {
      throw error(
        'PATCH_CONTEXT_NOT_FOUND',
        `Patch context was not found in ${path}`,
        {
          operation,
          hunk: hunkIndex,
          path,
          ...(hunk.anchor ? { anchor: hunk.anchor } : {}),
          candidates: [],
          suggestion: 'Read the latest file and submit a smaller context block',
        }
      );
    }
    if (candidates.length > 1) {
      throw error(
        'PATCH_CONTEXT_AMBIGUOUS',
        `Patch context matches ${candidates.length} locations in ${path}`,
        {
          operation,
          hunk: hunkIndex,
          path,
          ...(hunk.anchor ? { anchor: hunk.anchor } : {}),
          candidates: candidates.map((index) => index + 1),
          suggestion: 'Add a unique @@ anchor or more surrounding context',
        }
      );
    }
    const start = candidates[0];
    const replacement: string[] = [];
    for (const line of hunk.lines) {
      if (line.kind === 'context') replacement.push(line.text);
      else if (line.kind === 'add') {
        replacement.push(line.text);
        additions += 1;
      } else {
        deletions += 1;
      }
    }
    working.splice(start, oldLines.length, ...replacement);
  }
  const output =
    working.join('\n') + (hadFinalNewline || working.length === 0 ? '\n' : '');
  return {
    text: usesCrlf ? output.replace(/\n/g, '\r\n') : output,
    additions,
    deletions,
  };
}

function findLineSequence(lines: readonly string[], sequence: readonly string[]): number[] {
  const matches: number[] = [];
  for (let start = 0; start + sequence.length <= lines.length; start += 1) {
    let matched = true;
    for (let index = 0; index < sequence.length; index += 1) {
      if (lines[start + index] !== sequence[index]) {
        matched = false;
        break;
      }
    }
    if (matched) matches.push(start);
  }
  return matches;
}

async function remember(
  vfs: PatchFileSystem,
  path: string,
  originals: Map<string, OriginalFile>
): Promise<OriginalFile> {
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

function assertExpected(
  path: string,
  info: VirtualFileInfo | undefined,
  original: OriginalFile,
  options: ContextPatchOptions,
  operation: number
): void {
  const expectedVersion = options.expectedVersions?.[path];
  if (
    expectedVersion !== undefined &&
    (info?.version ?? 0) !== expectedVersion
  ) {
    throw error(
      'PATCH_STALE_FILE',
      `Patch expected version ${expectedVersion} for ${path}, current version is ${info?.version ?? 0}`,
      {
        operation,
        path,
        expectedVersion,
        actualVersion: info?.version ?? 0,
        suggestion: 'Read the latest file and retry with fresh context',
      }
    );
  }
  const expectedHash = options.expectedHashes?.[path];
  if (
    expectedHash !== undefined &&
    (!original.data || hashVirtualBytes(original.data) !== expectedHash)
  ) {
    throw error(
      'PATCH_STALE_FILE',
      `Patch expected hash does not match current file: ${path}`,
      {
        operation,
        path,
        expectedHash,
        suggestion: 'Read the latest file and retry with fresh context',
      }
    );
  }
}

async function rollback(
  vfs: PatchFileSystem,
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

function renderOperationDiff(
  operation: ContextPatchOperation,
  before: Uint8Array | undefined,
  after: Uint8Array | undefined
): string {
  if (operation.kind === 'update' && !operation.moveTo) {
    return unifiedDiff(before ?? new Uint8Array(), after ?? new Uint8Array(), operation.path).patch ?? '';
  }
  if (operation.kind === 'add') {
    return renderWholeFileDiff('', after ?? new Uint8Array(), operation.path, 'add');
  }
  if (operation.kind === 'delete') {
    return renderWholeFileDiff(before ?? new Uint8Array(), '', operation.path, 'delete');
  }
  return [
    renderWholeFileDiff(before ?? new Uint8Array(), '', operation.path, 'delete'),
    renderWholeFileDiff('', after ?? new Uint8Array(), operation.moveTo!, 'add'),
  ].filter(Boolean).join('\n');
}

function renderWholeFileDiff(
  before: string | Uint8Array,
  after: string | Uint8Array,
  path: string,
  kind: 'add' | 'delete'
): string {
  const bytes = kind === 'add' ? after : before;
  const text = typeof bytes === 'string' ? bytes : decodeVirtualText(bytes);
  if (text === undefined) return '';
  const lines = splitTextLines(text);
  const prefix = kind === 'add' ? '+' : '-';
  return [
    kind === 'add' ? '--- /dev/null' : `--- a/${path}`,
    kind === 'add' ? `+++ b/${path}` : '+++ /dev/null',
    kind === 'add'
      ? `@@ -0,0 +1,${lines.length} @@`
      : `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((line) => `${prefix}${line}`),
  ].join('\n');
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

function textLineCount(data: Uint8Array | undefined): number {
  if (!data) return 0;
  const text = decodeVirtualText(data);
  return text === undefined ? 1 : splitTextLines(text).length;
}

function safePath(value: string, line: number): string {
  const path = value.trim();
  if (!path) {
    throw invalid(`Patch path is empty at line ${line + 1}`);
  }
  return safeOperationPath(path, line);
}

function safeOperationPath(value: string, operation: number): string {
  if (
    value.startsWith('/') ||
    /^[a-zA-Z]:/.test(value) ||
    value.includes('\0') ||
    /[\u0001-\u001f\u007f]/.test(value)
  ) {
    throw error('PATCH_PATH_INVALID', `Patch path is invalid: ${value}`, {
      operation,
      path: value,
    });
  }
  const path = normalizeVirtualPath(value);
  if (!path) {
    throw invalid('Patch path is empty', { operation, path: value });
  }
  return path;
}

function invalid(message: string, details?: Record<string, unknown>): AgentError {
  return error('PATCH_PROTOCOL_INVALID', message, details);
}

function error(
  code: string,
  message: string,
  details?: Record<string, unknown>
): AgentError {
  return new AgentError(code, message, {
    ...(details ? { details: details as unknown as JsonValue } : {}),
  });
}

function cancelled(): AgentError {
  return new AgentError('PATCH_CANCELLED', 'Virtual context patch was cancelled');
}
