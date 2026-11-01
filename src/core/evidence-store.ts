import type { JsonValue } from './types';
import type { TestReport } from './test-report';

export type EvidenceStatus = 'current' | 'stale' | 'failed' | 'invalid';

export interface EvidenceRecord {
  id: string;
  sessionId: string;
  taskId: string;
  workspaceGeneration: number;
  environmentFingerprint: string;
  action: {
    id: string;
    version: string;
  };
  fileHashes: Record<string, string>;
  report?: TestReport;
  status: EvidenceStatus;
  reason?: string;
  artifactIds: string[];
  createdAt: number;
  data?: JsonValue;
}

export interface EvidenceStore {
  save(record: EvidenceRecord): Promise<void>;
  list(filter?: {
    sessionId?: string;
    taskId?: string;
  }): Promise<EvidenceRecord[]>;
}

export class InMemoryEvidenceStore implements EvidenceStore {
  private readonly records = new Map<string, EvidenceRecord>();

  async save(record: EvidenceRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async list(
    filter: { sessionId?: string; taskId?: string } = {}
  ): Promise<EvidenceRecord[]> {
    return [...this.records.values()]
      .filter(
        (record) =>
          (!filter.sessionId || record.sessionId === filter.sessionId) &&
          (!filter.taskId || record.taskId === filter.taskId)
      )
      .map((record) => structuredClone(record))
      .sort((left, right) => left.createdAt - right.createdAt);
  }
}
