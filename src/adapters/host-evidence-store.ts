import type {
  EvidenceRecord,
  EvidenceStore,
} from '../core/evidence-store';
import type { HostStorage } from '../host';

export class HostEvidenceStore implements EvidenceStore {
  constructor(
    private readonly storage: HostStorage,
    private readonly prefix = 'tinyai:evidence:v1:'
  ) {}

  async save(record: EvidenceRecord): Promise<void> {
    await this.storage.set(
      `${this.prefix}${encodeURIComponent(record.id)}`,
      record
    );
  }

  async list(
    filter: { sessionId?: string; taskId?: string } = {}
  ): Promise<EvidenceRecord[]> {
    const keys = (await this.storage.list?.(this.prefix)) ?? [];
    const records: EvidenceRecord[] = [];
    for (const key of keys) {
      const raw = await this.storage.get(key);
      if (!isEvidence(raw)) continue;
      if (filter.sessionId && raw.sessionId !== filter.sessionId) continue;
      if (filter.taskId && raw.taskId !== filter.taskId) continue;
      records.push(structuredClone(raw));
    }
    return records.sort((left, right) => left.createdAt - right.createdAt);
  }
}

function isEvidence(value: unknown): value is EvidenceRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<EvidenceRecord>;
  return Boolean(
    typeof record.id === 'string' &&
      typeof record.sessionId === 'string' &&
      typeof record.taskId === 'string' &&
      typeof record.workspaceGeneration === 'number' &&
      typeof record.environmentFingerprint === 'string' &&
      record.action &&
      typeof record.action.id === 'string' &&
      typeof record.action.version === 'string' &&
      record.fileHashes &&
      typeof record.fileHashes === 'object' &&
      ['current', 'stale', 'failed', 'invalid'].includes(
        String(record.status)
      ) &&
      Array.isArray(record.artifactIds) &&
      typeof record.createdAt === 'number'
  );
}
