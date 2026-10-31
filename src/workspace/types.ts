import type {
  ArtifactMetadata,
} from '../core/artifact-store';
import type { SessionSnapshot } from '../core/session-store';
import type { JsonValue } from '../core/types';
import type { WorkspaceBundle } from '../virtual/archive-fs';

export const WORKSPACE_CAPSULE_FORMAT = 'tinyai.workspace.capsule';
export const WORKSPACE_CAPSULE_SCHEMA_VERSION = 1;

export interface WorkspaceActionRequirement {
  id: string;
  versionRange?: string;
  required: boolean;
}

export interface WorkspaceEnvironmentManifest {
  manifestVersion: 1;
  requiredActions: WorkspaceActionRequirement[];
  requiredCapabilities: string[];
}

export interface WorkspaceEvidenceRecord {
  id: string;
  kind: 'command' | 'test' | 'review';
  actionId?: string;
  actionVersion?: string;
  environmentId?: string;
  status: 'current' | 'stale' | 'failed';
  fileHashes: Record<string, string>;
  createdAt: number;
  data?: JsonValue;
}

export interface WorkspaceArtifactRecord {
  metadata: ArtifactMetadata;
  dataBase64: string;
}

export interface WorkspaceClientState {
  clientId: string;
  state: JsonValue;
}

export interface WorkspaceRepositoryPartition {
  format: 'tinyai.git.repository';
  dataBase64: string;
}

export interface WorkspaceCapsulePartitions {
  project: WorkspaceBundle;
  repository?: WorkspaceRepositoryPartition;
  agentState: {
    sessions: SessionSnapshot[];
  };
  artifacts: {
    records: WorkspaceArtifactRecord[];
  };
  evidence: {
    records: WorkspaceEvidenceRecord[];
  };
  environment: WorkspaceEnvironmentManifest;
  clientState?: WorkspaceClientState;
}

export interface WorkspacePartitionRef {
  hash: string;
  bytes: number;
}

export interface WorkspaceCapsuleManifest {
  format: typeof WORKSPACE_CAPSULE_FORMAT;
  schemaVersion: typeof WORKSPACE_CAPSULE_SCHEMA_VERSION;
  capsuleId: string;
  workspaceId: string;
  generation: number;
  createdAt: number;
  producer: {
    agentVersion: string;
    hostProfile: string;
    environmentId: string;
  };
  partitions: Partial<Record<keyof WorkspaceCapsulePartitions, WorkspacePartitionRef>>;
  integrity: {
    algorithm: 'sha256';
    rootDigest: string;
  };
}

export interface WorkspaceCapsule {
  manifest: WorkspaceCapsuleManifest;
  partitions: WorkspaceCapsulePartitions;
}

export interface PreparedWorkspaceImport {
  capsule: WorkspaceCapsule;
  actionsMissing: string[];
  environmentChanged: boolean;
}

export interface WorkspaceImportResult {
  workspaceId: string;
  generation: number;
  sessions: string[];
  artifacts: number;
  environmentChanged: boolean;
  warnings: string[];
}
