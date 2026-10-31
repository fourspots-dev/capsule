import { AgentError } from '../core/errors';

const encoder = new TextEncoder();

export async function sha1(data: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new AgentError(
      'GIT_CRYPTO_UNAVAILABLE',
      'SHA-1 requires Web Crypto digest support'
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-1',
    toArrayBuffer(data)
  );
  return new Uint8Array(digest);
}

export async function sha1Hex(data: Uint8Array): Promise<string> {
  return bytesToHex(await sha1(data));
}

export async function deflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (typeof CompressionStream === 'undefined' || typeof Blob === 'undefined') {
    throw new AgentError(
      'GIT_COMPRESSION_UNAVAILABLE',
      'zlib compression is unavailable in this runtime'
    );
  }
  const stream = new Blob([toArrayBuffer(data)])
    .stream()
    .pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function inflateZlib(data: Uint8Array): Promise<Uint8Array> {
  if (
    typeof DecompressionStream === 'undefined' ||
    typeof Blob === 'undefined'
  ) {
    throw new AgentError(
      'GIT_COMPRESSION_UNAVAILABLE',
      'zlib decompression is unavailable in this runtime'
    );
  }
  try {
    const stream = new Blob([toArrayBuffer(data)])
      .stream()
      .pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (error) {
    throw new AgentError(
      'GIT_OBJECT_INVALID',
      `Invalid zlib stream: ${errorMessage(error)}`
    );
  }
}

export function bytesToHex(data: Uint8Array): string {
  let output = '';
  for (const byte of data) output += byte.toString(16).padStart(2, '0');
  return output;
}

export function hexToBytes(value: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    throw new AgentError('GIT_OBJECT_ID_INVALID', `Invalid hexadecimal value: ${value}`);
  }
  const result = new Uint8Array(value.length / 2);
  for (let index = 0; index < result.length; index += 1) {
    result[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return result;
}

export function concatBytes(...values: readonly Uint8Array[]): Uint8Array {
  const size = values.reduce((total, value) => total + value.byteLength, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export function compareBytes(left: Uint8Array, right: Uint8Array): number {
  const length = Math.min(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return left.byteLength - right.byteLength;
}

export function encodeText(value: string): Uint8Array {
  return encoder.encode(value);
}

export function decodeText(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

export function indexOfByte(
  data: Uint8Array,
  byte: number,
  start = 0
): number {
  for (let index = start; index < data.length; index += 1) {
    if (data[index] === byte) return index;
  }
  return -1;
}

export function readUint32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.byteLength) {
    throw invalidObject('Unexpected end of binary data');
  }
  return new DataView(
    data.buffer,
    data.byteOffset + offset,
    4
  ).getUint32(0, false);
}

export function writeUint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value >>> 0, false);
  return result;
}

export function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  try {
    const binary = atob(value);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index);
    }
    return result;
  } catch {
    throw new AgentError('GIT_REPOSITORY_INVALID', 'Invalid base64 data');
  }
}

export function readUint16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.byteLength) {
    throw invalidObject('Unexpected end of binary data');
  }
  return new DataView(
    data.buffer,
    data.byteOffset + offset,
    2
  ).getUint16(0, false);
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}

function invalidObject(message: string): AgentError {
  return new AgentError('GIT_OBJECT_INVALID', message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
