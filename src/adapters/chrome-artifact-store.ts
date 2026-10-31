import type {
  ArtifactInput,
  ArtifactMetadata,
  ArtifactRef,
  ArtifactStore,
} from '../core/artifact-store';
import { AgentError } from '../core/errors';
import type { ChromeKeyValueStorage } from '../runtime/chrome-runtime';

interface StoredArtifact {
  metadata: ArtifactMetadata;
  dataBase64: string;
}

export class ChromeArtifactStore implements ArtifactStore {
  private readonly prefix: string;

  constructor(
    private readonly storage: ChromeKeyValueStorage & {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
    },
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
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  }

  private readonly now: () => number;
  private readonly newId: () => string;

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    if (!(input.data instanceof Uint8Array) || !input.name.trim()) {
      throw new AgentError('ARTIFACT_INPUT_INVALID', 'Artifact name and binary data are required');
    }
    const metadata: ArtifactMetadata = {
      id: this.newId(),
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.data.byteLength,
      createdAt: this.now(),
      kind: input.kind,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    await this.storage.set({
      [this.key(metadata.id)]: {
        metadata,
        dataBase64: bytesToBase64(input.data),
      } satisfies StoredArtifact,
    });
    return {
      artifactId: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      bytes: metadata.bytes,
      kind: metadata.kind,
    };
  }

  async metadata(artifactId: string): Promise<ArtifactMetadata | undefined> {
    return (await this.load(artifactId))?.metadata;
  }

  async restore(metadata: ArtifactMetadata, data: Uint8Array): Promise<ArtifactRef> {
    if (!metadata.id || !metadata.name.trim()) {
      throw new AgentError('ARTIFACT_INPUT_INVALID', 'Artifact metadata is invalid');
    }
    await this.storage.set({
      [this.key(metadata.id)]: {
        metadata: { ...metadata },
        dataBase64: bytesToBase64(data),
      } satisfies StoredArtifact,
    });
    return {
      artifactId: metadata.id,
      name: metadata.name,
      mimeType: metadata.mimeType,
      bytes: metadata.bytes,
      kind: metadata.kind,
    };
  }

  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const artifact = await this.load(artifactId);
    return artifact ? base64ToBytes(artifact.dataBase64) : undefined;
  }

  async remove(artifactId: string): Promise<boolean> {
    const existing = await this.load(artifactId);
    if (!existing) return false;
    if (!this.storage.remove) {
      throw new AgentError('CHROME_STORAGE_UNAVAILABLE', 'storage.remove is unavailable');
    }
    await this.storage.remove(this.key(artifactId));
    return true;
  }

  async list(filter: {
    sessionId?: string;
    taskId?: string;
    kind?: ArtifactMetadata['kind'];
  } = {}): Promise<ArtifactMetadata[]> {
    const all = await this.storage.get(null);
    return Object.entries(all)
      .filter(([key]) => key.startsWith(this.prefix))
      .map(([, value]) => validate(value))
      .filter((artifact): artifact is StoredArtifact => Boolean(artifact))
      .map((artifact) => artifact.metadata)
      .filter((metadata) => !filter.sessionId || metadata.sessionId === filter.sessionId)
      .filter((metadata) => !filter.taskId || metadata.taskId === filter.taskId)
      .filter((metadata) => !filter.kind || metadata.kind === filter.kind)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((metadata) => ({ ...metadata }));
  }

  async cleanup(before: number): Promise<number> {
    const artifacts = await this.list();
    const expired = artifacts.filter((artifact) => artifact.createdAt < before);
    for (const artifact of expired) await this.remove(artifact.id);
    return expired.length;
  }

  private async load(artifactId: string): Promise<StoredArtifact | undefined> {
    const stored = await this.storage.get(this.key(artifactId));
    return validate(stored[this.key(artifactId)]);
  }

  private key(artifactId: string): string {
    return `${this.prefix}${encodeURIComponent(artifactId)}`;
  }
}

function validate(value: unknown): StoredArtifact | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const artifact = value as Partial<StoredArtifact>;
  if (
    !artifact.metadata ||
    typeof artifact.metadata.id !== 'string' ||
    typeof artifact.metadata.name !== 'string' ||
    typeof artifact.metadata.bytes !== 'number' ||
    typeof artifact.dataBase64 !== 'string'
  ) {
    return undefined;
  }
  return {
    metadata: { ...artifact.metadata },
    dataBase64: artifact.dataBase64,
  };
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
