import { AgentError } from '../core/errors';
import {
  bytesToHex,
  concatBytes,
  hexToBytes,
  inflateZlib,
  readUint32,
  sha1,
} from './binary';
import type { GitFileSystem, GitObject, GitObjectType } from './types';

interface PackEntry {
  oid: string;
  offset: number;
  packPath: string;
}

interface ParsedPackIndex {
  entries: Map<string, PackEntry>;
  offsets: Array<{ offset: number; oid: string }>;
  packChecksum: string;
}

const objectTypes: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export class GitPackStore {
  private loaded?: Promise<Map<string, PackEntry>>;
  private readonly packData = new Map<string, Promise<Uint8Array>>();

  constructor(
    private readonly fs: GitFileSystem,
    private readonly gitDir = '.git'
  ) {}

  async readObject(oid: string): Promise<GitObject> {
    const entries = await this.load();
    const entry = entries.get(oid.toLowerCase());
    if (!entry) {
      throw new AgentError('GIT_OBJECT_NOT_FOUND', `Git object not found: ${oid}`);
    }
    return this.readPacked(entry, 0);
  }

  async hasObject(oid: string): Promise<boolean> {
    return (await this.load()).has(oid.toLowerCase());
  }

  private async load(): Promise<Map<string, PackEntry>> {
    this.loaded ??= this.loadAll();
    return this.loaded;
  }

  private async loadAll(): Promise<Map<string, PackEntry>> {
    const entries = new Map<string, PackEntry>();
    const root = `${this.gitDir}/objects/pack`;
    if (!(await this.fs.stat(root))) return entries;
    const files = await this.fs.list(root, { recursive: true });
    for (const file of files) {
      if (file.kind !== 'file' || !file.path.endsWith('.idx')) continue;
      const packPath = file.path.slice(0, -4) + '.pack';
      if (!(await this.fs.stat(packPath))) continue;
      const index = await parsePackIndex(await this.fs.read(file.path));
      for (const [oid, entry] of index.entries) {
        if (entries.has(oid)) {
          throw new AgentError(
            'GIT_PACK_INVALID',
            `Object ${oid} appears in multiple pack indexes`
          );
        }
        entries.set(oid, { ...entry, packPath });
      }
    }
    return entries;
  }

  private async readPacked(entry: PackEntry, depth: number): Promise<GitObject> {
    if (depth > 32) {
      throw new AgentError('GIT_PACK_INVALID', 'Pack delta chain is too deep');
    }
    const data = await this.pack(entry.packPath);
    const index = await this.indexFor(entry.packPath);
    const position = index.offsets.findIndex((item) => item.offset === entry.offset);
    if (position < 0) {
      throw new AgentError('GIT_PACK_INVALID', `Pack offset missing: ${entry.offset}`);
    }
    const nextOffset = index.offsets[position + 1]?.offset ?? data.byteLength - 20;
    if (nextOffset <= entry.offset || nextOffset > data.byteLength - 20) {
      throw new AgentError('GIT_PACK_INVALID', 'Invalid packed object boundary');
    }
    const header = parseObjectHeader(data, entry.offset);
    const end = nextOffset;
    const compressed = data.subarray(header.dataOffset, end);
    const inflated = await inflateZlib(compressed);
    if (header.type !== 6 && header.type !== 7) {
      if (inflated.byteLength !== header.size) {
        throw new AgentError('GIT_PACK_INVALID', 'Packed object size mismatch');
      }
      const type = objectTypes[header.type];
      if (!type) {
        throw new AgentError('GIT_PACK_INVALID', `Unknown packed object type: ${header.type}`);
      }
      return { type, data: inflated };
    }

    let base: GitObject;
    if (header.type === 6) {
      const baseOffset = header.baseOffset;
      if (baseOffset === undefined) {
        throw new AgentError('GIT_PACK_INVALID', 'OFS_DELTA base offset is missing');
      }
      const baseOid = index.offsets.find(
        (item) => item.offset === baseOffset
      )?.oid;
      if (!baseOid) {
        throw new AgentError('GIT_PACK_INVALID', 'OFS_DELTA base is missing');
      }
      base = await this.readPacked(
        { oid: baseOid, offset: baseOffset, packPath: entry.packPath },
        depth + 1
      );
    } else {
      if (!header.baseOid) {
        throw new AgentError('GIT_PACK_INVALID', 'REF_DELTA base is missing');
      }
      base = await this.readObject(header.baseOid);
    }
    const result = applyDelta(base.data, inflated);
    if (result.byteLength !== header.size) {
      throw new AgentError('GIT_PACK_INVALID', 'Delta result size mismatch');
    }
    return { type: base.type, data: result };
  }

  private async pack(path: string): Promise<Uint8Array> {
    let pending = this.packData.get(path);
    if (!pending) {
      pending = this.fs.read(path);
      this.packData.set(path, pending);
    }
    return pending;
  }

  private async indexFor(path: string): Promise<ParsedPackIndex> {
    return parsePackIndex(await this.fs.read(path.slice(0, -5) + '.idx'));
  }
}

function parsePackIndex(data: Uint8Array): ParsedPackIndex {
  if (
    data.byteLength < 8 + 256 * 4 + 40 ||
    readUint32(data, 0) !== 0xff744f63 ||
    readUint32(data, 4) !== 2
  ) {
    throw new AgentError('GIT_PACK_INDEX_INVALID', 'Unsupported Git pack index');
  }
  const count = readUint32(data, 8 + 255 * 4);
  const oidTable = 8 + 256 * 4;
  const checksumTable = oidTable + count * 20;
  const offsetTable = checksumTable + count * 4;
  const largeOffsetTable = offsetTable + count * 4;
  if (largeOffsetTable + 40 > data.byteLength) {
    throw new AgentError('GIT_PACK_INDEX_INVALID', 'Truncated Git pack index');
  }
  const entries = new Map<string, PackEntry>();
  const offsets: Array<{ offset: number; oid: string }> = [];
  for (let index = 0; index < count; index += 1) {
    const oid = bytesToHex(
      data.subarray(oidTable + index * 20, oidTable + (index + 1) * 20)
    );
    const rawOffset = readUint32(data, offsetTable + index * 4);
    const offset =
      rawOffset & 0x80000000
        ? readUint64(
            data,
            largeOffsetTable + (rawOffset & 0x7fffffff) * 8
          )
        : rawOffset;
    entries.set(oid, { oid, offset, packPath: '' });
    offsets.push({ offset, oid });
  }
  offsets.sort((left, right) => left.offset - right.offset);
  const packChecksum = bytesToHex(
    data.subarray(data.byteLength - 40, data.byteLength - 20)
  );
  return { entries, offsets, packChecksum };
}

function parseObjectHeader(
  data: Uint8Array,
  offset: number
): {
  type: number;
  size: number;
  dataOffset: number;
  baseOffset?: number;
  baseOid?: string;
} {
  let cursor = offset;
  let byte = data[cursor++];
  if (byte === undefined) throw invalidPack('Missing packed object header');
  const type = (byte >>> 4) & 0x7;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = data[cursor++];
    if (byte === undefined || shift > 56) throw invalidPack('Invalid packed object size');
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  if (type === 6) {
    byte = data[cursor++];
    if (byte === undefined) throw invalidPack('Missing OFS_DELTA base');
    let baseOffset = byte & 0x7f;
    while (byte & 0x80) {
      byte = data[cursor++];
      if (byte === undefined) throw invalidPack('Invalid OFS_DELTA base');
      baseOffset = ((baseOffset + 1) * 128) + (byte & 0x7f);
    }
    return {
      type,
      size,
      dataOffset: cursor,
      baseOffset: offset - baseOffset,
    };
  }
  if (type === 7) {
    if (cursor + 20 > data.byteLength) throw invalidPack('Missing REF_DELTA base');
    const baseOid = bytesToHex(data.subarray(cursor, cursor + 20));
    return { type, size, dataOffset: cursor + 20, baseOid };
  }
  return { type, size, dataOffset: cursor };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
  let offset = 0;
  const baseSize = readDeltaVarint(delta, offset);
  offset = baseSize.offset;
  const resultSize = readDeltaVarint(delta, offset);
  offset = resultSize.offset;
  if (baseSize.value !== base.byteLength || resultSize.value > 512 * 1024 * 1024) {
    throw invalidPack('Invalid delta sizes');
  }
  const chunks: Uint8Array[] = [];
  let written = 0;
  while (offset < delta.byteLength) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) copyOffset |= delta[offset++];
      if (op & 0x02) copyOffset |= delta[offset++] << 8;
      if (op & 0x04) copyOffset |= delta[offset++] << 16;
      if (op & 0x08) copyOffset |= delta[offset++] << 24;
      if (op & 0x10) copySize |= delta[offset++];
      if (op & 0x20) copySize |= delta[offset++] << 8;
      if (op & 0x40) copySize |= delta[offset++] << 16;
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.byteLength) {
        throw invalidPack('Delta copy exceeds base object');
      }
      chunks.push(base.subarray(copyOffset, copyOffset + copySize));
      written += copySize;
    } else if (op > 0) {
      if (offset + op > delta.byteLength) {
        throw invalidPack('Delta insert exceeds stream');
      }
      chunks.push(delta.subarray(offset, offset + op));
      offset += op;
      written += op;
    } else {
      throw invalidPack('Delta opcode 0 is invalid');
    }
  }
  if (written !== resultSize.value) throw invalidPack('Delta result size mismatch');
  return concatBytes(...chunks);
}

function readDeltaVarint(
  data: Uint8Array,
  offset: number
): { value: number; offset: number } {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = data[offset++];
    if (byte === undefined || shift > 49) throw invalidPack('Invalid delta varint');
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return { value, offset };
}

function readUint64(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 8 > data.byteLength) throw invalidPack('Truncated uint64');
  const view = new DataView(data.buffer, data.byteOffset + offset, 8);
  const value = view.getBigUint64(0, false);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw invalidPack('Pack offset exceeds safe integer range');
  }
  return Number(value);
}

function invalidPack(message: string): AgentError {
  return new AgentError('GIT_PACK_INVALID', message);
}
