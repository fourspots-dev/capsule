import { AgentError } from '../core/errors';
import {
  bytesToHex,
  compareBytes,
  concatBytes,
  decodeText,
  deflateZlib,
  encodeText,
  hexToBytes,
  indexOfByte,
  inflateZlib,
  sha1,
  sha1Hex,
} from './binary';
import type {
  GitFileSystem,
  GitObject,
  GitObjectType,
  GitTreeEntry,
} from './types';
import { GitPackStore } from './pack';

const encoder = new TextEncoder();

export class GitObjectStore {
  private readonly packs: GitPackStore;

  constructor(
    private readonly fs: GitFileSystem,
    readonly gitDir = '.git'
  ) {
    this.packs = new GitPackStore(fs, gitDir);
  }

  async hashObject(type: GitObjectType, data: Uint8Array): Promise<string> {
    return sha1Hex(encodeObject(type, data));
  }

  async writeObject(type: GitObjectType, data: Uint8Array): Promise<string> {
    const canonical = encodeObject(type, data);
    const oid = bytesToHex(await sha1(canonical));
    const path = this.objectPath(oid);
    if (!(await this.fs.stat(path))) {
      await this.fs.mkdir(path.slice(0, path.lastIndexOf('/')), {
        recursive: true,
      });
      await this.fs.write(path, await deflateZlib(canonical), { mode: 0o444 });
    }
    return oid;
  }

  async readObject(oid: string): Promise<GitObject> {
    assertOid(oid);
    const loosePath = this.objectPath(oid);
    const info = await this.fs.stat(loosePath);
    if (!info) {
      const packed = await this.packs.readObject(oid);
      const canonical = encodeObject(packed.type, packed.data);
      const actual = bytesToHex(await sha1(canonical));
      if (actual !== oid.toLowerCase()) {
        throw new AgentError(
          'GIT_OBJECT_INVALID',
          `Packed Git object hash mismatch: expected ${oid}, received ${actual}`
        );
      }
      return packed;
    }
    const compressed = await this.fs.read(loosePath);
    const canonical = await inflateZlib(compressed);
    const actual = bytesToHex(await sha1(canonical));
    if (actual !== oid.toLowerCase()) {
      throw new AgentError(
        'GIT_OBJECT_INVALID',
        `Git object hash mismatch: expected ${oid}, received ${actual}`
      );
    }
    return parseObjectBytes(canonical);
  }

  async readBlob(oid: string): Promise<Uint8Array> {
    const object = await this.readObject(oid);
    if (object.type !== 'blob') {
      throw new AgentError('GIT_OBJECT_TYPE', `Object ${oid} is not a blob`);
    }
    return object.data;
  }

  async readTree(oid: string): Promise<GitTreeEntry[]> {
    const object = await this.readObject(oid);
    if (object.type !== 'tree') {
      throw new AgentError('GIT_OBJECT_TYPE', `Object ${oid} is not a tree`);
    }
    return decodeTree(object.data);
  }

  private objectPath(oid: string): string {
    return `${this.gitDir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
  }
}

export function encodeTree(entries: readonly GitTreeEntry[]): Uint8Array {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    if (!entry.name || entry.name.includes('/') || entry.name.includes('\0')) {
      throw new AgentError(
        'GIT_TREE_INVALID',
        `Invalid tree entry name: ${JSON.stringify(entry.name)}`
      );
    }
    assertOid(entry.oid);
    parts.push(
      encoder.encode(`${entry.mode.toString(8)} ${entry.name}\0`),
      hexToBytes(entry.oid)
    );
  }
  return concatBytes(...parts);
}

export function decodeTree(data: Uint8Array): GitTreeEntry[] {
  const entries: GitTreeEntry[] = [];
  let offset = 0;
  while (offset < data.byteLength) {
    const space = indexOfByte(data, 0x20, offset);
    const nul = space < 0 ? -1 : indexOfByte(data, 0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.byteLength) {
      throw new AgentError('GIT_TREE_INVALID', 'Malformed Git tree object');
    }
    const modeText = decodeText(data.subarray(offset, space));
    const mode = Number.parseInt(modeText, 8);
    if (!Number.isInteger(mode) || mode <= 0) {
      throw new AgentError('GIT_TREE_INVALID', `Invalid Git tree mode: ${modeText}`);
    }
    const name = decodeText(data.subarray(space + 1, nul));
    if (!name || name.includes('/')) {
      throw new AgentError('GIT_TREE_INVALID', 'Invalid Git tree entry name');
    }
    const oid = bytesToHex(data.subarray(nul + 1, nul + 21));
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function encodeCommit(input: {
  tree: string;
  parents: readonly string[];
  authorName: string;
  authorEmail: string;
  authorTimestamp: number;
  authorTimezone: string;
  committerName: string;
  committerEmail: string;
  committerTimestamp: number;
  committerTimezone: string;
  message: string;
}): Uint8Array {
  assertOid(input.tree);
  for (const parent of input.parents) assertOid(parent);
  const lines = [
    `tree ${input.tree}`,
    ...input.parents.map((parent) => `parent ${parent}`),
    `author ${sanitizeIdentity(input.authorName)} <${sanitizeEmail(input.authorEmail)}> ${Math.trunc(input.authorTimestamp)} ${input.authorTimezone}`,
    `committer ${sanitizeIdentity(input.committerName)} <${sanitizeEmail(input.committerEmail)}> ${Math.trunc(input.committerTimestamp)} ${input.committerTimezone}`,
    '',
    input.message.endsWith('\n') ? input.message : `${input.message}\n`,
  ];
  return encoder.encode(lines.join('\n'));
}

export function parseCommit(
  oid: string,
  data: Uint8Array
): {
  tree: string;
  parents: string[];
  author: { name: string; email: string; timestamp: number; timezone: string };
  committer: { name: string; email: string; timestamp: number; timezone: string };
  message: string;
} {
  const text = decodeText(data);
  const separator = text.indexOf('\n\n');
  if (separator < 0) {
    throw new AgentError('GIT_COMMIT_INVALID', `Malformed commit object: ${oid}`);
  }
  const headers = text.slice(0, separator).split('\n');
  let tree: string | undefined;
  const parents: string[] = [];
  let author: ReturnType<typeof parseSignature> | undefined;
  let committer: ReturnType<typeof parseSignature> | undefined;
  for (const line of headers) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = parseSignature(line.slice(7));
    else if (line.startsWith('committer ')) committer = parseSignature(line.slice(10));
  }
  if (!tree || !author || !committer) {
    throw new AgentError('GIT_COMMIT_INVALID', `Incomplete commit object: ${oid}`);
  }
  assertOid(tree);
  for (const parent of parents) assertOid(parent);
  return { tree, parents, author, committer, message: text.slice(separator + 2) };
}

export function encodeObject(type: GitObjectType, data: Uint8Array): Uint8Array {
  return concatBytes(
    encoder.encode(`${type} ${data.byteLength}\0`),
    data
  );
}

function parseObjectBytes(data: Uint8Array): GitObject {
  const nul = indexOfByte(data, 0);
  if (nul < 0) {
    throw new AgentError('GIT_OBJECT_INVALID', 'Git object header is missing');
  }
  const header = decodeText(data.subarray(0, nul));
  const [type, sizeText] = header.split(' ');
  const size = Number(sizeText);
  if (
    !['blob', 'tree', 'commit', 'tag'].includes(type) ||
    !Number.isInteger(size) ||
    size < 0 ||
    nul + 1 + size !== data.byteLength
  ) {
    throw new AgentError('GIT_OBJECT_INVALID', `Invalid Git object header: ${header}`);
  }
  return {
    type: type as GitObjectType,
    data: new Uint8Array(data.subarray(nul + 1)),
  };
}

function compareTreeEntries(left: GitTreeEntry, right: GitTreeEntry): number {
  const leftKey = encoder.encode(
    left.mode === 0o40000 ? `${left.name}/` : left.name
  );
  const rightKey = encoder.encode(
    right.mode === 0o40000 ? `${right.name}/` : right.name
  );
  return compareBytes(leftKey, rightKey);
}

function assertOid(oid: string): void {
  if (!/^[0-9a-f]{40}$/i.test(oid)) {
    throw new AgentError('GIT_OBJECT_ID_INVALID', `Invalid SHA-1 object id: ${oid}`);
  }
}

function parseSignature(value: string): {
  name: string;
  email: string;
  timestamp: number;
  timezone: string;
} {
  const match = /^(.*) <([^>]*)> (-?\d+) ([+-]\d{4})$/.exec(value);
  if (!match) {
    throw new AgentError('GIT_COMMIT_INVALID', `Invalid commit signature: ${value}`);
  }
  return {
    name: match[1],
    email: match[2],
    timestamp: Number(match[3]),
    timezone: match[4],
  };
}

function sanitizeIdentity(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim() || 'tinyai';
}

function sanitizeEmail(value: string): string {
  return value.replace(/[\r\n<>]/g, '').trim() || 'tinyai@localhost';
}
