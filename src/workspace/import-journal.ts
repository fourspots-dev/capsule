import type { SessionSnapshot } from '../core/session-store';
import type { WorkspaceBundle } from '../virtual';
import type {
  WorkspaceArtifactRecord,
  WorkspaceEvidenceRecord,
} from './types';

export type WorkspaceImportStage =
  | 'planned'
  | 'project'
  | 'repository'
  | 'sessions'
  | 'artifacts'
  | 'evidence'
  | 'metadata';

export interface WorkspaceImportBackup {
  project: WorkspaceBundle;
  repository?: Uint8Array;
  sessions: SessionSnapshot[];
  artifacts: WorkspaceArtifactRecord[];
  evidence: WorkspaceEvidenceRecord[];
}

export interface PendingWorkspaceImport {
  id: string;
  stage: WorkspaceImportStage;
  backup: WorkspaceImportBackup;
}

export interface WorkspaceImportJournal {
  begin(backup: WorkspaceImportBackup): Promise<string>;
  stage(id: string, stage: WorkspaceImportStage): Promise<void>;
  complete(id: string): Promise<void>;
  fail(id: string): Promise<void>;
  pending(): Promise<PendingWorkspaceImport | undefined>;
}

export class InMemoryWorkspaceImportJournal implements WorkspaceImportJournal {
  private sequence = 0;
  private current?: PendingWorkspaceImport;

  async begin(backup: WorkspaceImportBackup): Promise<string> {
    const id = `import_${++this.sequence}`;
    this.current = {
      id,
      stage: 'planned',
      backup: structuredClone(backup),
    };
    return id;
  }

  async stage(id: string, stage: WorkspaceImportStage): Promise<void> {
    if (this.current?.id === id) this.current.stage = stage;
  }

  async complete(id: string): Promise<void> {
    if (this.current?.id === id) this.current = undefined;
  }

  async fail(id: string): Promise<void> {
    if (this.current?.id === id) this.current = undefined;
  }

  async pending(): Promise<PendingWorkspaceImport | undefined> {
    return this.current ? structuredClone(this.current) : undefined;
  }
}
