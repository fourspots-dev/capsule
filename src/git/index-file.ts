import { AgentError } from '../core/errors';
import {
  bytesToHex,
  compareBytes,
  concatBytes,
  hexToBytes,
  readUint16,
  readUint32,
  sha1,
  writeUint32,
} from './binary';
import { normalizeGitPath } from './path';
import type { GitFileInfo, GitFileSystem, GitIndexEntry } from './types';

const SIGNATURE = 0x44495243;
const VERSION = 2;

export async function readGitIndex(
  fs: GitFileSystem,
  gitDir = '.git'
): Promise<GitIndexEntry[]> {
  const path = `${gitDir}/index`;
  if (!(await fs.stat(path))) return [];
  const data = await fs.read(path);
  if (data.byteLength < 32 || readUint32(data, 0) !== SIGNATURE) {
    throw invalidIndex('Missing DIRC signature');
  }
  const version = readUint32(data, 4);
  if (version < 2 || version > 4) {
    throw new AgentError(
      'GIT_INDEX_UNSUPPORTED',
      `Unsupported Git index version: ${version}`
    );
  }
  const count = readUint32(data, 8);
  const expected = bytesToHex(await sha1(data.subarray(0, data.byteLength - 20)));
  const actual = bytesToHex(data.subarray(data.byteLength - 20));
  if (expected !== actual) {
    throw invalidIndex(`Git index checksum mismatch: expected ${expected}, received ${actual}`);
  }
  const entries: GitIndexEntry[] = [];
  let offset = 12;
  let previousPath = '';
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (offset + 62 > data.byteLength - 20) {
      throw invalidIndex('Truncated Git index entry');
    }
    const flags = readUint16(data, offset + 60);
    offset += 62;
    let path: string;
    if (version === 4) {
      const remove = readIndexVarint(data, offset);
      offset = remove.offset;
      const nul = findNul(data, offset, data.byteLength - 20);
      const suffix = new TextDecoder().decode(data.subarray(offset, nul));
      path = previousPath.slice(0, Math.max(0, previousPath.length - remove.value)) + suffix;
      offset = nul + 1;
      previousPath = path;
    } else {
      const declared = flags & 0x0fff;
      const nul = declared < 0x0fff ? offset + declared : findNul(data, offset, data.byteLength - 20);
      path = new TextDecoder().decode(data.subarray(offset, nul));
      offset = start + Math.ceil((nul + 1 - start) / 8) * 8;
    }
    entries.push({
      ctimeSeconds: readUint32(data, start),
      ctimeNanos: readUint32(data, start + 4),
      mtimeSeconds: readUint32(data, start + 8),
      mtimeNanos: readUint32(data, start + 12),
      dev: readUint32(data, start + 16),
      ino: readUint32(data, start + 20),
      mode: readUint32(data, start + 24),
      uid: readUint32(data, start + 28),
      gid: readUint32(data, start + 32),
      size: readUint32(data, start + 36),
      oid: bytesToHex(data.subarray(start + 40, start + 60)),
      flags,
      stage: (flags >>> 12) & 0x3,
      path: normalizeGitPath(path),
    });
  }
  while (offset + 8 <= data.byteLength - 20) {
    const signature = new TextDecoder().decode(data.subarray(offset, offset + 4));
    const size = readUint32(data, offset + 4);
    offset += 8;
    if (offset + size > data.byteLength - 20) throw invalidIndex('Truncated index extension');
    if (
      /^[A-Z]/.test(signature) &&
      !['TREE', 'REUC', 'UNTR'].includes(signature)
    ) {
      throw new AgentError(
        'GIT_INDEX_UNSUPPORTED',
        `Unsupported required Git index extension: ${signature}`
      );
    }
    offset += size;
  }
  return entries;
}

export async function writeGitIndex(
  fs: GitFileSystem,
  entries: readonly GitIndexEntry[],
  gitDir = '.git'
): Promise<void> {
  const sorted = [...entries].sort(compareIndexEntries);
  const parts: Uint8Array[] = [
    writeUint32(SIGNATURE),
    writeUint32(VERSION),
    writeUint32(sorted.length),
  ];
  for (const entry of sorted) {
    const path = new TextEncoder().encode(normalizeGitPath(entry.path));
    const flags =
      (entry.flags & 0xf000) |
      ((entry.stage & 0x3) << 12) |
      Math.min(path.byteLength, 0x0fff);
    const fixed = new Uint8Array(62);
    const view = new DataView(fixed.buffer);
    view.setUint32(0, entry.ctimeSeconds >>> 0, false);
    view.setUint32(4, entry.ctimeNanos >>> 0, false);
    view.setUint32(8, entry.mtimeSeconds >>> 0, false);
    view.setUint32(12, entry.mtimeNanos >>> 0, false);
    view.setUint32(16, entry.dev >>> 0, false);
    view.setUint32(20, entry.ino >>> 0, false);
    view.setUint32(24, entry.mode >>> 0, false);
    view.setUint32(28, entry.uid >>> 0, false);
    view.setUint32(32, entry.gid >>> 0, false);
    view.setUint32(36, entry.size >>> 0, false);
    fixed.set(hexToBytes(entry.oid), 40);
    view.setUint16(60, flags, false);
    const raw = concatBytes(fixed, path);
    const paddedLength = Math.ceil((raw.byteLength + 1) / 8) * 8;
    const encoded = new Uint8Array(paddedLength);
    encoded.set(raw);
    parts.push(encoded);
  }
  const body = concatBytes(...parts);
  const checksum = await sha1(body);
  const data = concatBytes(body, checksum);
  await fs.write(`${gitDir}/index`, data, { mode: 0o644 });
}

export function indexEntryFromFile(
  file: GitFileInfo,
  oid: string,
  stage = 0
): GitIndexEntry {
  const seconds = Math.max(0, Math.trunc(file.modifiedAt / 1000));
  const nanos = Math.max(0, Math.trunc(file.modifiedAt % 1000) * 1_000_000);
  return {
    path: normalizeGitPath(file.path),
    oid,
    mode: file.mode & 0o111 ? 0o100755 : 0o100644,
    stage,
    ctimeSeconds: seconds,
    ctimeNanos: nanos,
    mtimeSeconds: seconds,
    mtimeNanos: nanos,
    dev: 0,
    ino: 0,
    uid: 0,
    gid: 0,
    size: file.size,
    flags: 0,
  };
}

export function compareIndexEntries(left: GitIndexEntry, right: GitIndexEntry): number {
  return compareBytes(
    new TextEncoder().encode(left.path),
    new TextEncoder().encode(right.path)
  ) || left.stage - right.stage;
}

function readIndexVarint(data: Uint8Array, offset: number): { value: number; offset: number } {
  let byte = data[offset++];
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = data[offset++];
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, offset };
}

function findNul(data: Uint8Array, start: number, end: number): number {
  for (let index = start; index < end; index += 1) {
    if (data[index] === 0) return index;
  }
  throw invalidIndex('Git index path is not NUL terminated');
}

function invalidIndex(message: string): AgentError {
  return new AgentError('GIT_INDEX_INVALID', message);
}
