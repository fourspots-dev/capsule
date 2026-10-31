import type {
  ArtifactInput,
  ArtifactMetadata,
  ArtifactRef,
  ArtifactStore,
} from '../core/artifact-store';
import { AgentError } from '../core/errors';
import type { HostStorage } from '../host';

interface StoredHostArtifact {
  metadata: ArtifactMetadata;
  dataBase64: string;
}

export class HostArtifactStore implements ArtifactStore {
  private readonly prefix: string;
  private readonly now: () => number;
  private readonly newId: () => string;
  private sequence = 0;

  constructor(
    private readonly storage: HostStorage,
    options: {
      keyPrefix?: string;
      now?: () => number;
      newId?: () => string;
    } = {}
  ) {
    this.prefix = options.keyPrefix ?? 'tinyai:artifact:v1:';
    this.now = options.now ?? (() => Date.now());
    this.newId =
      options.newId ??
      (() =>
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `artifact_${Date.now()}_${++this.sequence}`);
  }

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    if (!input.name.trim() || !(input.data instanceof Uint8Array)) {
      throw new AgentError(
        'ARTIFACT_INPUT_INVALID',
        'Artifact name and binary data are required'
      );
    }
    return this.store(
      {
        id: this.newId(),
        name: input.name,
        mimeType: input.mimeType,
        kind: input.kind,
        bytes: input.data.byteLength,
        createdAt: this.now(),
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        ...(input.taskId ? { taskId: input.taskId } : {}),
      },
      input.data
    );
  }

  async restore(metadata: ArtifactMetadata, data: Uint8Array): Promise<ArtifactRef> {
    return this.store(metadata, data);
  }

  async metadata(artifactId: string): Promise<ArtifactMetadata | undefined> {
    return (await this.load(artifactId))?.metadata;
  }

  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const artifact = await this.load(artifactId);
    return artifact ? base64ToBytes(artifact.dataBase64) : undefined;
  }

  async remove(artifactId: string): Promise<boolean> {
    const existing = await this.load(artifactId);
    if (!existing) return false;
    await this.storage.remove(this.key(artifactId));
    return true;
  }

  async list(filter: {
    sessionId?: string;
    taskId?: string;
    kind?: ArtifactMetadata['kind'];
  } = {}): Promise<ArtifactMetadata[]> {
    const keys = (await this.storage.list?.(this.prefix)) ?? [];
    const result: ArtifactMetadata[] = [];
    for (const key of keys) {
      const raw = await this.storage.get(key);
      const artifact = validate(raw);
      if (!artifact) continue;
      if (filter.sessionId && artifact.metadata.sessionId !== filter.sessionId) continue;
      if (filter.taskId && artifact.metadata.taskId !== filter.taskId) continue;
      if (filter.kind && artifact.metadata.kind !== filter.kind) continue;
      result.push({ ...artifact.metadata });
    }
    return result.sort((left, right) => left.createdAt - right.createdAt);
  }

  async cleanup(before: number): Promise<number> {
    const expired = (await this.list()).filter((item) => item.createdAt < before);
    for (const artifact of expired) await this.remove(artifact.id);
    return expired.length;
  }

  private async store(
    metadata: ArtifactMetadata,
    data: Uint8Array
  ): Promise<ArtifactRef> {
    await this.storage.set(this.key(metadata.id), {
      metadata: { ...metadata, bytes: data.byteLength },
      dataBase64: bytesToBase64(data),
    } satisfies StoredHostArtifact);
    return {
      artifactId: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      bytes: data.byteLength,
      kind: metadata.kind,
    };
  }

  private async load(artifactId: string): Promise<StoredHostArtifact | undefined> {
    return validate(await this.storage.get(this.key(artifactId)));
  }

  private key(artifactId: string): string {
    return `${this.prefix}${encodeURIComponent(artifactId)}`;
  }
}

function validate(value: unknown): StoredHostArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const artifact = value as Partial<StoredHostArtifact>;
  if (
    !artifact.metadata ||
    typeof artifact.metadata.id !== 'string' ||
    typeof artifact.metadata.name !== 'string' ||
    typeof artifact.metadata.mimeType !== 'string' ||
    typeof artifact.metadata.bytes !== 'number' ||
    typeof artifact.metadata.createdAt !== 'number' ||
    typeof artifact.dataBase64 !== 'string'
  ) {
    return undefined;
  }
  return {
    metadata: { ...artifact.metadata } as ArtifactMetadata,
    dataBase64: artifact.dataBase64,
  };
}

function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
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
