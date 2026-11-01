import { AgentError } from '../core/errors';
import type { JsonValue } from '../core/types';
import {
  canonicalJson,
  parseWorkspaceCapsule,
  sha256Hex,
} from './codec';
import type {
  WorkspaceCapsule,
  WorkspaceCapsulePartitions,
} from './types';

export const CAPSULE_V2_MAGIC = new TextEncoder().encode('TNYCAP2\n');
export const CAPSULE_V2_FORMAT = 'tinyai.workspace.capsule.v2';
export const CAPSULE_V2_SCHEMA_VERSION = 2;
const DEFAULT_CHUNK_BYTES = 256 * 1024;

interface CapsuleV2Partition {
  name: keyof WorkspaceCapsulePartitions;
  rawBytes: number;
  compressedBytes: number;
  hash: string;
  encoding: 'gzip';
  chunks: Array<{
    offset: number;
    bytes: number;
    hash: string;
  }>;
}

interface CapsuleV2Header {
  format: typeof CAPSULE_V2_FORMAT;
  schemaVersion: typeof CAPSULE_V2_SCHEMA_VERSION;
  manifest: WorkspaceCapsule['manifest'];
  chunkBytes: number;
  partitions: CapsuleV2Partition[];
  integrity: {
    algorithm: 'sha256';
    rootDigest: string;
  };
}

export interface CapsuleV2EncodeOptions {
  chunkBytes?: number;
}

export async function* encodeWorkspaceCapsuleV2Chunks(
  capsule: WorkspaceCapsule,
  options: CapsuleV2EncodeOptions = {}
): AsyncGenerator<Uint8Array> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? DEFAULT_CHUNK_BYTES);
  const partitions: CapsuleV2Partition[] = [];
  const payloads: Uint8Array[] = [];
  for (const [name, value] of Object.entries(capsule.partitions) as Array<
    [
      keyof WorkspaceCapsulePartitions,
      WorkspaceCapsulePartitions[keyof WorkspaceCapsulePartitions],
    ]
  >) {
    if (value === undefined) continue;
    const raw = new TextEncoder().encode(
      canonicalJson(value as unknown as JsonValue)
    );
    const compressed = await gzip(raw);
    const chunks: CapsuleV2Partition['chunks'] = [];
    for (let offset = 0; offset < compressed.byteLength; offset += chunkBytes) {
      const chunk = compressed.slice(
        offset,
        Math.min(compressed.byteLength, offset + chunkBytes)
      );
      chunks.push({
        offset,
        bytes: chunk.byteLength,
        hash: await sha256Hex(chunk),
      });
      payloads.push(chunk);
    }
    partitions.push({
      name,
      rawBytes: raw.byteLength,
      compressedBytes: compressed.byteLength,
      hash: await sha256Hex(raw),
      encoding: 'gzip',
      chunks,
    });
  }
  const partitionMetadata = partitions.map((partition) => ({
    name: partition.name,
    rawBytes: partition.rawBytes,
    compressedBytes: partition.compressedBytes,
    hash: partition.hash,
    encoding: partition.encoding,
    chunks: partition.chunks,
  }));
  const rootDigest = await sha256Hex(
    new TextEncoder().encode(
      canonicalJson(partitionMetadata as unknown as JsonValue)
    )
  );
  const header: CapsuleV2Header = {
    format: CAPSULE_V2_FORMAT,
    schemaVersion: CAPSULE_V2_SCHEMA_VERSION,
    manifest: capsule.manifest,
    chunkBytes,
    partitions,
    integrity: { algorithm: 'sha256', rootDigest },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, headerBytes.byteLength);
  yield concatBytes([CAPSULE_V2_MAGIC, length, headerBytes]);
  for (const payload of payloads) yield payload;
}

export async function serializeWorkspaceCapsuleV2(
  capsule: WorkspaceCapsule,
  options: CapsuleV2EncodeOptions = {}
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of encodeWorkspaceCapsuleV2Chunks(
    capsule,
    options
  )) {
    chunks.push(chunk);
  }
  return concatBytes(chunks);
}

export async function parseWorkspaceCapsuleV2(
  input: Uint8Array
): Promise<WorkspaceCapsule> {
  if (!startsWith(input, CAPSULE_V2_MAGIC)) {
    throw invalid('Workspace capsule is not Capsule v2');
  }
  let cursor = CAPSULE_V2_MAGIC.byteLength;
  requireBytes(input, cursor, 4);
  const headerLength = new DataView(
    input.buffer,
    input.byteOffset + cursor,
    4
  ).getUint32(0);
  cursor += 4;
  requireBytes(input, cursor, headerLength);
  let header: CapsuleV2Header;
  try {
    header = JSON.parse(
      new TextDecoder().decode(input.slice(cursor, cursor + headerLength))
    ) as CapsuleV2Header;
  } catch {
    throw invalid('Capsule v2 header is not valid JSON');
  }
  cursor += headerLength;
  if (
    header.format !== CAPSULE_V2_FORMAT ||
    header.schemaVersion !== CAPSULE_V2_SCHEMA_VERSION ||
    !Array.isArray(header.partitions)
  ) {
    throw new AgentError(
      'CAPSULE_SCHEMA_UNSUPPORTED',
      `Unsupported Capsule v2 header: ${String(header.schemaVersion)}`
    );
  }
  const expectedRoot = await sha256Hex(
    new TextEncoder().encode(
      canonicalJson(
        header.partitions.map((partition) => ({
          name: partition.name,
          rawBytes: partition.rawBytes,
          compressedBytes: partition.compressedBytes,
          hash: partition.hash,
          encoding: partition.encoding,
          chunks: partition.chunks,
        })) as unknown as JsonValue
      )
    )
  );
  if (expectedRoot !== header.integrity.rootDigest) {
    throw invalid('Capsule v2 metadata digest mismatch');
  }
  const capsule: WorkspaceCapsule = {
    manifest: header.manifest,
    partitions: {} as WorkspaceCapsulePartitions,
  };
  for (const partition of header.partitions) {
    const compressedChunks: Uint8Array[] = [];
    for (const chunk of partition.chunks) {
      requireBytes(input, cursor, chunk.bytes);
      const bytes = input.slice(cursor, cursor + chunk.bytes);
      cursor += chunk.bytes;
      if ((await sha256Hex(bytes)) !== chunk.hash) {
        throw invalid(`Capsule v2 chunk integrity mismatch: ${partition.name}`);
      }
      compressedChunks.push(bytes);
    }
    const raw = await gunzip(concatBytes(compressedChunks));
    if (
      raw.byteLength !== partition.rawBytes ||
      (await sha256Hex(raw)) !== partition.hash
    ) {
      throw invalid(`Capsule v2 partition integrity mismatch: ${partition.name}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw invalid(`Capsule v2 partition is not JSON: ${partition.name}`);
    }
    (capsule.partitions as unknown as Record<string, unknown>)[partition.name] =
      value;
  }
  if (cursor !== input.byteLength) {
    throw invalid('Capsule v2 contains trailing bytes');
  }
  return parseWorkspaceCapsule(capsule);
}

export async function parseWorkspaceCapsuleAuto(
  input: Uint8Array | WorkspaceCapsule
): Promise<WorkspaceCapsule> {
  if (input instanceof Uint8Array && startsWith(input, CAPSULE_V2_MAGIC)) {
    return parseWorkspaceCapsuleV2(input);
  }
  return parseWorkspaceCapsule(input);
}

async function gzip(data: Uint8Array): Promise<Uint8Array> {
  return transform(data, new CompressionStream('gzip'));
}

async function gunzip(data: Uint8Array): Promise<Uint8Array> {
  return transform(data, new DecompressionStream('gzip'));
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const writing = writer
    .write(copy as unknown as BufferSource)
    .then(() => writer.close());
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(new Uint8Array(value));
  }
  await writing;
  return concatBytes(chunks);
}

function requireBytes(input: Uint8Array, offset: number, length: number): void {
  if (offset + length > input.byteLength) {
    throw invalid('Capsule v2 is truncated');
  }
}

function startsWith(input: Uint8Array, prefix: Uint8Array): boolean {
  if (input.byteLength < prefix.byteLength) return false;
  return prefix.every((value, index) => input[index] === value);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function invalid(message: string): AgentError {
  return new AgentError('CAPSULE_INVALID', message);
}
