import { AgentError } from './errors';
import type { JsonValue } from './types';

export interface ArtifactMetadata {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  createdAt: number;
  sessionId?: string;
  taskId?: string;
  kind: 'text' | 'image' | 'pdf' | 'log' | 'diff' | 'binary';
}

export interface ArtifactRef {
  artifactId: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: ArtifactMetadata['kind'];
}

export interface ArtifactInput {
  name: string;
  mimeType: string;
  data: Uint8Array;
  kind: ArtifactMetadata['kind'];
  sessionId?: string;
  taskId?: string;
}

export interface ArtifactStore {
  put(input: ArtifactInput): Promise<ArtifactRef>;
  restore?(metadata: ArtifactMetadata, data: Uint8Array): Promise<ArtifactRef>;
  metadata(artifactId: string): Promise<ArtifactMetadata | undefined>;
  read(artifactId: string): Promise<Uint8Array | undefined>;
  remove(artifactId: string): Promise<boolean>;
  list(filter?: { sessionId?: string; taskId?: string; kind?: ArtifactMetadata['kind'] }): Promise<ArtifactMetadata[]>;
  cleanup(before: number): Promise<number>;
}

export interface ArtifactIdGenerator {
  next(): string;
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly artifacts = new Map<string, { metadata: ArtifactMetadata; data: Uint8Array }>();
  private sequence = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ids: ArtifactIdGenerator = { next: () => `artifact_${++this.sequence}` }
  ) {}

  async put(input: ArtifactInput): Promise<ArtifactRef> {
    if (!input.name.trim()) throw new AgentError('ARTIFACT_NAME_INVALID', 'Artifact name is required');
    if (!(input.data instanceof Uint8Array)) {
      throw new AgentError('ARTIFACT_DATA_INVALID', 'Artifact data must be a Uint8Array');
    }
    const metadata: ArtifactMetadata = {
      id: this.ids.next(),
      name: input.name,
      mimeType: input.mimeType,
      bytes: input.data.byteLength,
      createdAt: this.now(),
      kind: input.kind,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.taskId ? { taskId: input.taskId } : {}),
    };
    this.artifacts.set(metadata.id, {
      metadata,
      data: new Uint8Array(input.data),
    });
    return toRef(metadata);
  }

  async metadata(artifactId: string): Promise<ArtifactMetadata | undefined> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? { ...artifact.metadata } : undefined;
  }

  async restore(metadata: ArtifactMetadata, data: Uint8Array): Promise<ArtifactRef> {
    if (!metadata.id || !metadata.name.trim() || !(data instanceof Uint8Array)) {
      throw new AgentError('ARTIFACT_DATA_INVALID', 'Artifact metadata or data is invalid');
    }
    this.artifacts.set(metadata.id, {
      metadata: { ...metadata },
      data: new Uint8Array(data),
    });
    return toRef(metadata);
  }

  async read(artifactId: string): Promise<Uint8Array | undefined> {
    const artifact = this.artifacts.get(artifactId);
    return artifact ? new Uint8Array(artifact.data) : undefined;
  }

  async remove(artifactId: string): Promise<boolean> {
    return this.artifacts.delete(artifactId);
  }

  async list(filter: {
    sessionId?: string;
    taskId?: string;
    kind?: ArtifactMetadata['kind'];
  } = {}): Promise<ArtifactMetadata[]> {
    return [...this.artifacts.values()]
      .map((artifact) => artifact.metadata)
      .filter((metadata) => !filter.sessionId || metadata.sessionId === filter.sessionId)
      .filter((metadata) => !filter.taskId || metadata.taskId === filter.taskId)
      .filter((metadata) => !filter.kind || metadata.kind === filter.kind)
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((metadata) => ({ ...metadata }));
  }

  async cleanup(before: number): Promise<number> {
    let removed = 0;
    for (const [id, artifact] of this.artifacts) {
      if (artifact.metadata.createdAt < before) {
        this.artifacts.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

export function artifactRefJson(ref: ArtifactRef): JsonValue {
  return { ...ref };
}

export function textArtifact(
  store: ArtifactStore,
  input: Omit<ArtifactInput, 'data' | 'mimeType' | 'kind'> & {
    text: string;
    mimeType?: string;
    kind?: ArtifactMetadata['kind'];
  }
): Promise<ArtifactRef> {
  return store.put({
    ...input,
    mimeType: input.mimeType ?? 'text/plain; charset=utf-8',
    kind: input.kind ?? 'text',
    data: new TextEncoder().encode(input.text),
  });
}

function toRef(metadata: ArtifactMetadata): ArtifactRef {
  return {
    artifactId: metadata.id,
    name: metadata.name,
    mimeType: metadata.mimeType,
    bytes: metadata.bytes,
    kind: metadata.kind,
  };
}
