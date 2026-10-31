import { AgentError } from '../core/errors';
import type { JsonValue } from '../core/types';
import type {
  WorkspaceCapsule,
  WorkspaceCapsuleManifest,
  WorkspaceCapsulePartitions,
  WorkspacePartitionRef,
} from './types';
import {
  WORKSPACE_CAPSULE_FORMAT,
  WORKSPACE_CAPSULE_SCHEMA_VERSION,
} from './types';
import { validatePortableWorkspacePaths } from './path-policy';

const encoder = new TextEncoder();

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export async function sha256Hex(value: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new AgentError(
      'CAPSULE_CRYPTO_UNAVAILABLE',
      'SHA-256 support is required'
    );
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    value.buffer.slice(
      value.byteOffset,
      value.byteOffset + value.byteLength
    ) as ArrayBuffer
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export async function buildWorkspaceCapsule(input: {
  capsuleId: string;
  workspaceId: string;
  generation: number;
  createdAt: number;
  producer: WorkspaceCapsuleManifest['producer'];
  partitions: WorkspaceCapsulePartitions;
}): Promise<WorkspaceCapsule> {
  const partitions = normalizePartitions(input.partitions);
  validateProjectPaths(partitions);
  const refs: WorkspaceCapsuleManifest['partitions'] = {};
  for (const [name, value] of Object.entries(partitions) as Array<
    [keyof WorkspaceCapsulePartitions, WorkspaceCapsulePartitions[keyof WorkspaceCapsulePartitions]]
  >) {
    if (value === undefined) continue;
    const bytes = encoder.encode(canonicalJson(value as unknown as JsonValue));
    refs[name] = {
      hash: await sha256Hex(bytes),
      bytes: bytes.byteLength,
    };
  }
  const rootDigest = await sha256Hex(
    encoder.encode(canonicalJson(refs as unknown as JsonValue))
  );
  return {
    manifest: {
      format: WORKSPACE_CAPSULE_FORMAT,
      schemaVersion: WORKSPACE_CAPSULE_SCHEMA_VERSION,
      capsuleId: input.capsuleId,
      workspaceId: input.workspaceId,
      generation: input.generation,
      createdAt: input.createdAt,
      producer: { ...input.producer },
      partitions: refs,
      integrity: { algorithm: 'sha256', rootDigest },
    },
    partitions,
  };
}

export function serializeWorkspaceCapsule(capsule: WorkspaceCapsule): Uint8Array {
  return encoder.encode(canonicalJson(capsule as unknown as JsonValue));
}

export async function parseWorkspaceCapsule(
  input: Uint8Array | WorkspaceCapsule
): Promise<WorkspaceCapsule> {
  let value: unknown = input;
  if (input instanceof Uint8Array) {
    try {
      value = JSON.parse(new TextDecoder().decode(input));
    } catch {
      throw invalidCapsule('Capsule is not valid JSON');
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidCapsule('Capsule must be an object');
  }
  const candidate = value as WorkspaceCapsule;
  if (
    candidate.manifest?.format !== WORKSPACE_CAPSULE_FORMAT ||
    candidate.manifest.schemaVersion !== WORKSPACE_CAPSULE_SCHEMA_VERSION
  ) {
    throw new AgentError(
      'CAPSULE_SCHEMA_UNSUPPORTED',
      `Unsupported workspace capsule schema: ${String(candidate.manifest?.schemaVersion)}`
    );
  }
  if (!candidate.partitions?.project) {
    throw invalidCapsule('Capsule project partition is missing');
  }
  validateProjectPaths(candidate.partitions);
  validateManifest(candidate.manifest);
  const refs = candidate.manifest.partitions;
  for (const name of requiredPartitions) {
    if (!refs[name]) throw invalidCapsule(`Required partition is missing: ${name}`);
  }
  for (const [name, value] of Object.entries(candidate.partitions) as Array<
    [keyof WorkspaceCapsulePartitions, WorkspaceCapsulePartitions[keyof WorkspaceCapsulePartitions]]
  >) {
    if (value === undefined) continue;
    const ref = refs[name];
    if (!ref) throw invalidCapsule(`Partition reference is missing: ${name}`);
    const bytes = encoder.encode(canonicalJson(value as unknown as JsonValue));
    const hash = await sha256Hex(bytes);
    if (hash !== ref.hash || bytes.byteLength !== ref.bytes) {
      throw invalidCapsule(`Partition integrity mismatch: ${name}`);
    }
  }
  const expectedRoot = await sha256Hex(
    encoder.encode(canonicalJson(refs as unknown as JsonValue))
  );
  if (expectedRoot !== candidate.manifest.integrity.rootDigest) {
    throw invalidCapsule('Capsule root digest mismatch');
  }
  return {
    manifest: candidate.manifest,
    partitions: normalizePartitions(candidate.partitions),
  };
}

const requiredPartitions: Array<keyof WorkspaceCapsulePartitions> = [
  'project',
  'agentState',
  'artifacts',
  'evidence',
  'environment',
];

function validateManifest(manifest: WorkspaceCapsuleManifest): void {
  if (
    !manifest.capsuleId ||
    !manifest.workspaceId ||
    !Number.isInteger(manifest.generation) ||
    manifest.generation < 0 ||
    !Number.isFinite(manifest.createdAt) ||
    !manifest.producer?.agentVersion ||
    !manifest.producer.hostProfile ||
    !manifest.producer.environmentId ||
    manifest.integrity?.algorithm !== 'sha256' ||
    typeof manifest.integrity.rootDigest !== 'string'
  ) {
    throw invalidCapsule('Capsule manifest is incomplete');
  }
}

function normalizePartitions(
  partitions: WorkspaceCapsulePartitions
): WorkspaceCapsulePartitions {
  return {
    project: {
      ...partitions.project,
      directories: [...partitions.project.directories].sort(),
      files: [...partitions.project.files].sort((left, right) =>
        left.path.localeCompare(right.path)
      ),
    },
    ...(partitions.repository
      ? { repository: { ...partitions.repository } }
      : {}),
    agentState: {
      sessions: [...partitions.agentState.sessions].sort((left, right) =>
        left.sessionId.localeCompare(right.sessionId)
      ),
    },
    artifacts: {
      records: [...partitions.artifacts.records].sort((left, right) =>
        left.metadata.id.localeCompare(right.metadata.id)
      ),
    },
    evidence: {
      records: [...partitions.evidence.records].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
    },
    environment: {
      manifestVersion: 1,
      requiredActions: [...partitions.environment.requiredActions].sort((left, right) =>
        left.id.localeCompare(right.id)
      ),
      requiredCapabilities: [...partitions.environment.requiredCapabilities].sort(),
    },
    ...(partitions.clientState
      ? { clientState: structuredClone(partitions.clientState) }
      : {}),
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

function invalidCapsule(message: string): AgentError {
  return new AgentError('CAPSULE_INVALID', message);
}

function validateProjectPaths(partitions: WorkspaceCapsulePartitions): void {
  validatePortableWorkspacePaths([
    ...partitions.project.directories,
    ...partitions.project.files.map((file) => file.path),
  ]);
}
