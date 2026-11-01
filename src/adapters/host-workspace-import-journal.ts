import type { HostStorage } from '../host';
import type {
  PendingWorkspaceImport,
  WorkspaceImportBackup,
  WorkspaceImportJournal,
  WorkspaceImportStage,
} from '../workspace/import-journal';

interface StoredJournal {
  schemaVersion: 1;
  id: string;
  stage: WorkspaceImportStage;
  backup: {
    project: WorkspaceImportBackup['project'];
    repositoryBase64?: string;
    sessions: WorkspaceImportBackup['sessions'];
    artifacts: WorkspaceImportBackup['artifacts'];
    evidence: WorkspaceImportBackup['evidence'];
  };
}

export class HostWorkspaceImportJournal implements WorkspaceImportJournal {
  constructor(
    private readonly storage: HostStorage,
    private readonly key = 'tinyai:workspace-import:v1'
  ) {}

  async begin(backup: WorkspaceImportBackup): Promise<string> {
    const id = `import_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    await this.save({
      schemaVersion: 1,
      id,
      stage: 'planned',
      backup: {
        project: structuredClone(backup.project),
        ...(backup.repository
          ? { repositoryBase64: bytesToBase64(backup.repository) }
          : {}),
        sessions: structuredClone(backup.sessions),
        artifacts: structuredClone(backup.artifacts),
        evidence: structuredClone(backup.evidence),
      },
    });
    return id;
  }

  async stage(id: string, stage: WorkspaceImportStage): Promise<void> {
    const current = await this.load();
    if (!current || current.id !== id) return;
    await this.save({ ...current, stage });
  }

  async complete(id: string): Promise<void> {
    const current = await this.load();
    if (current?.id === id) await this.storage.remove(this.key);
  }

  async fail(id: string): Promise<void> {
    await this.complete(id);
  }

  async pending(): Promise<PendingWorkspaceImport | undefined> {
    const current = await this.load();
    if (!current) return undefined;
    return {
      id: current.id,
      stage: current.stage,
      backup: {
        project: structuredClone(current.backup.project),
        ...(current.backup.repositoryBase64
          ? { repository: base64ToBytes(current.backup.repositoryBase64) }
          : {}),
        sessions: structuredClone(current.backup.sessions),
        artifacts: structuredClone(current.backup.artifacts),
        evidence: structuredClone(current.backup.evidence),
      },
    };
  }

  private async save(value: StoredJournal): Promise<void> {
    await this.storage.set(this.key, value);
  }

  private async load(): Promise<StoredJournal | undefined> {
    const value = await this.storage.get(this.key);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (structuredClone(value) as StoredJournal)
      : undefined;
  }
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
