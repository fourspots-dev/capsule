import type { ArtifactMetadata, ArtifactStore } from '../core/artifact-store';
import { AgentError } from '../core/errors';
import {
  cloneSnapshot,
  type SessionSnapshot,
  type SessionStore,
} from '../core/session-store';
import type { JsonValue } from '../core/types';
import { base64ToBytes, bytesToBase64 } from '../git/binary';
import type { GitBackend } from '../git/types';
import type { HostBridge } from '../host';
import type { AvailableHostAction } from '../platform/host-action';
import { createWorkspaceBundle, type WorkspaceBundle } from '../virtual/archive-fs';
import type { VirtualFileSystem } from '../virtual/types';
import {
  buildWorkspaceCapsule,
  parseWorkspaceCapsule,
  sha256Hex,
  serializeWorkspaceCapsule,
} from './codec';
import type {
  PreparedWorkspaceImport,
  WorkspaceArtifactRecord,
  WorkspaceCapsule,
  WorkspaceClientState,
  WorkspaceEnvironmentManifest,
  WorkspaceEvidenceRecord,
  WorkspaceImportResult,
} from './types';

export interface WorkspaceContinuityOptions {
  workspaceId: string;
  generation?: number;
  vfs: VirtualFileSystem;
  git?: GitBackend;
  sessions?: SessionStore;
  artifacts?: ArtifactStore;
  environment: WorkspaceEnvironmentManifest;
  clientState?: WorkspaceClientState;
  evidence?: () => Promise<WorkspaceEvidenceRecord[]>;
  beforeExport?: () => Promise<void>;
  now?: () => number;
  newId?: () => string;
  agentVersion?: string;
  hostProfile?: string;
  environmentId: string;
}

export class WorkspaceContinuityService {
  private generation: number;
  private readonly now: () => number;
  private evidenceRecords: WorkspaceEvidenceRecord[] = [];
  private workspaceId: string;
  private importedRequiredActions: WorkspaceEnvironmentManifest['requiredActions'] = [];
  private importedRequiredCapabilities: string[] = [];

  constructor(private readonly options: WorkspaceContinuityOptions) {
    this.generation = options.generation ?? 0;
    this.now = options.now ?? (() => Date.now());
    this.workspaceId = options.workspaceId;
  }

  async exportCapsule(): Promise<WorkspaceCapsule> {
    await this.options.beforeExport?.();
    const sessions = await this.collectSessions();
    const artifacts = await this.collectArtifacts();
    this.evidenceRecords =
      (await this.options.evidence?.()) ?? this.evidenceRecords;
    const repository =
      this.options.git?.exportRepository &&
      (await this.options.git.repository?.())
        ? {
            format: 'tinyai.git.repository' as const,
            dataBase64: bytesToBase64(await this.options.git.exportRepository()),
          }
        : undefined;
    return buildWorkspaceCapsule({
      capsuleId: this.options.newId?.() ?? `capsule_${this.now()}`,
      workspaceId: this.workspaceId,
      generation: this.generation,
      createdAt: this.now(),
      producer: {
        agentVersion: this.options.agentVersion ?? '0.3.0-dev',
        hostProfile: this.options.hostProfile ?? 'portable',
        environmentId: this.options.environmentId,
      },
      partitions: {
        project: await this.collectProject(),
        ...(repository ? { repository } : {}),
        agentState: { sessions },
        artifacts: { records: artifacts },
        evidence: {
          records: this.evidenceRecords,
        },
        environment: this.effectiveEnvironment(),
        ...(this.options.clientState
          ? { clientState: this.options.clientState }
          : {}),
      },
    });
  }

  async transferToHost(host: HostBridge): Promise<WorkspaceCapsule> {
    if (typeof host.workspace?.exportWorkspace !== 'function') {
      throw new AgentError(
        'HOST_CAPABILITY_MISSING',
        `Host ${host.descriptor.id} does not support workspace.export`
      );
    }
    const capsule = await this.exportCapsule();
    await host.workspace.exportWorkspace(serializeWorkspaceCapsule(capsule));
    return capsule;
  }

  async prepareImport(
    input: Uint8Array | WorkspaceCapsule,
    options: {
      availableActions?: readonly AvailableHostAction[];
    } = {}
  ): Promise<PreparedWorkspaceImport> {
    const capsule = await parseWorkspaceCapsule(input);
    const actions = new Map(
      (options.availableActions ?? []).map((action) => [
        action.descriptor.id,
        action.descriptor,
      ])
    );
    const actionsMissing: string[] = [];
    for (const requirement of capsule.partitions.environment.requiredActions) {
      const action = actions.get(requirement.id);
      const missing = !action;
      const incompatible =
        action &&
        requirement.versionRange &&
        /^v?\d+\.\d+\.\d+$/.test(requirement.versionRange) &&
        requirement.versionRange.replace(/^v/, '') !== action.version;
      if (missing || incompatible) {
        actionsMissing.push(requirement.id);
        if (requirement.required) {
          throw new AgentError(
            'CAPSULE_ACTION_MISSING',
            `Required application action is unavailable: ${requirement.id}`,
            { details: { actionId: requirement.id } }
          );
        }
      }
    }
    return {
      capsule,
      actionsMissing,
      environmentChanged:
        capsule.manifest.producer.environmentId !== this.options.environmentId,
    };
  }

  async importFromHost(
    host: HostBridge,
    options: {
      availableActions?: readonly AvailableHostAction[];
      replaceProject?: boolean;
    } = {}
  ): Promise<WorkspaceImportResult> {
    if (typeof host.workspace?.importWorkspace !== 'function') {
      throw new AgentError(
        'HOST_CAPABILITY_MISSING',
        `Host ${host.descriptor.id} does not support workspace.import`
      );
    }
    const bytes = await host.workspace.importWorkspace();
    if (!bytes) {
      throw new AgentError('CAPSULE_IMPORT_EMPTY', 'Host returned no workspace capsule');
    }
    const prepared = await this.prepareImport(bytes, options);
    return this.commitImport(prepared, options);
  }

  async commitImport(
    prepared: PreparedWorkspaceImport,
    options: { replaceProject?: boolean } = {}
  ): Promise<WorkspaceImportResult> {
    const capsule = prepared.capsule;
    const warnings = prepared.actionsMissing.map(
      (actionId) => `Application action unavailable: ${actionId}`
    );
    const backup = await this.captureBackup();
    try {
      await this.materializeProject(
        capsule.partitions.project,
        options.replaceProject === true
      );
      if (capsule.partitions.repository && this.options.git?.importRepository) {
        if (await this.options.vfs.stat('.git')) {
          await this.options.vfs.remove('.git', { recursive: true });
        }
        await this.options.git.importRepository(
          base64ToBytes(capsule.partitions.repository.dataBase64)
        );
      }
      const sessions = capsule.partitions.agentState.sessions.map((snapshot) =>
        reconcileSession(
          snapshot,
          prepared.environmentChanged,
          this.options.environmentId,
          this.now()
        )
      );
      if (this.options.sessions) {
        for (const session of sessions) await this.options.sessions.save(session);
      }
      await this.restoreArtifacts(capsule.partitions.artifacts.records);
      this.evidenceRecords = await this.reconcileEvidence(
        capsule.partitions.evidence.records,
        prepared.environmentChanged
      );
      this.generation = Math.max(
        this.generation + 1,
        capsule.manifest.generation + 1
      );
      this.workspaceId = capsule.manifest.workspaceId;
      this.importedRequiredActions = mergeActionRequirements(
        this.importedRequiredActions,
        capsule.partitions.environment.requiredActions
      );
      this.importedRequiredCapabilities = [
        ...new Set([
          ...this.importedRequiredCapabilities,
          ...capsule.partitions.environment.requiredCapabilities,
        ]),
      ].sort();
      return {
        workspaceId: capsule.manifest.workspaceId,
        generation: this.generation,
        sessions: sessions.map((session) => session.sessionId),
        artifacts: capsule.partitions.artifacts.records.length,
        environmentChanged: prepared.environmentChanged,
        warnings,
      };
    } catch (error) {
      await this.restoreBackup(backup);
      throw error;
    }
  }

  currentGeneration(): number {
    return this.generation;
  }

  evidence(): WorkspaceEvidenceRecord[] {
    return this.evidenceRecords.map((record) => ({
      ...record,
      fileHashes: { ...record.fileHashes },
      ...(record.data === undefined ? {} : { data: structuredClone(record.data) }),
    }));
  }

  private effectiveEnvironment(): WorkspaceEnvironmentManifest {
    return {
      manifestVersion: 1,
      requiredActions: mergeActionRequirements(
        this.options.environment.requiredActions,
        this.importedRequiredActions
      ),
      requiredCapabilities: [
        ...new Set([
          ...this.options.environment.requiredCapabilities,
          ...this.importedRequiredCapabilities,
        ]),
      ].sort(),
    };
  }

  private async collectProject(): Promise<WorkspaceBundle> {
    const files: Array<{ path: string; dataBase64: string; mode?: number; modifiedAt?: number }> = [];
    const directories: string[] = [];
    for (const entry of await this.options.vfs.list('', { recursive: true })) {
      if (entry.path === '.git' || entry.path.startsWith('.git/')) continue;
      if (entry.path === '.tinyai' || entry.path.startsWith('.tinyai/')) continue;
      if (entry.kind === 'directory') directories.push(entry.path);
      else {
        files.push({
          path: entry.path,
          dataBase64: bytesToBase64(await this.options.vfs.read(entry.path)),
          mode: entry.mode,
          modifiedAt: entry.modifiedAt,
        });
      }
    }
    return createWorkspaceBundle({
      files,
      directories,
      createdAt: this.now(),
      metadata: { workspaceId: this.options.workspaceId },
    });
  }

  private async collectSessions(): Promise<SessionSnapshot[]> {
    if (!this.options.sessions) return [];
    const sessions = [];
    for (const summary of (await this.options.sessions.list?.()) ?? []) {
      const snapshot = await this.options.sessions.load(summary.sessionId);
      if (snapshot) sessions.push(cloneSnapshot(snapshot));
    }
    return sessions;
  }

  private async collectArtifacts(): Promise<WorkspaceArtifactRecord[]> {
    if (!this.options.artifacts) return [];
    const records: WorkspaceArtifactRecord[] = [];
    for (const metadata of await this.options.artifacts.list()) {
      const data = await this.options.artifacts.read(metadata.id);
      if (!data) {
        throw new AgentError(
          'CAPSULE_ARTIFACT_MISSING',
          `Artifact content is missing: ${metadata.id}`
        );
      }
      records.push({
        metadata: { ...metadata },
        dataBase64: bytesToBase64(data),
      });
    }
    return records;
  }

  private async materializeProject(
    project: WorkspaceBundle,
    replace: boolean
  ): Promise<void> {
    if (replace) {
      for (const entry of (await this.options.vfs.list('', { recursive: true }))
        .filter((item) => item.kind === 'file')
        .filter((item) => item.path !== '.git' && !item.path.startsWith('.git/'))
        .filter((item) => item.path !== '.tinyai' && !item.path.startsWith('.tinyai/'))
        .sort((left, right) => right.path.length - left.path.length)) {
        await this.options.vfs.remove(entry.path);
      }
    }
    for (const directory of project.directories) {
      await this.options.vfs.mkdir(directory, { recursive: true });
    }
    for (const file of project.files) {
      await this.options.vfs.write(file.path, base64ToBytes(file.dataBase64), {
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      });
    }
  }

  private async restoreArtifacts(records: readonly WorkspaceArtifactRecord[]): Promise<void> {
    if (!this.options.artifacts || !records.length) return;
    if (!this.options.artifacts.restore) {
      throw new AgentError(
        'CAPSULE_ARTIFACT_RESTORE_UNSUPPORTED',
        'Artifact store does not support stable restoration'
      );
    }
    for (const record of records) {
      await this.options.artifacts.restore(
        record.metadata,
        base64ToBytes(record.dataBase64)
      );
    }
  }

  private async reconcileEvidence(
    records: readonly WorkspaceEvidenceRecord[],
    environmentChanged: boolean
  ): Promise<WorkspaceEvidenceRecord[]> {
    const result: WorkspaceEvidenceRecord[] = [];
    for (const record of records) {
      let current = !environmentChanged && record.status === 'current';
      if (current) {
        for (const [path, expected] of Object.entries(record.fileHashes)) {
          const info = await this.options.vfs.stat(path);
          if (!info) {
            current = false;
            break;
          }
          const actual = await sha256Hex(await this.options.vfs.read(path));
          if (actual !== expected) {
            current = false;
            break;
          }
        }
      }
      result.push({
        ...record,
        status: record.status === 'failed' ? 'failed' : current ? 'current' : 'stale',
        fileHashes: { ...record.fileHashes },
        ...(record.data === undefined ? {} : { data: structuredClone(record.data) }),
      });
    }
    return result;
  }

  private async captureBackup(): Promise<{
    project: WorkspaceBundle;
    repository?: Uint8Array;
    sessions: SessionSnapshot[];
    artifacts: WorkspaceArtifactRecord[];
  }> {
    const repository =
      this.options.git?.exportRepository &&
      (await this.options.git.repository?.())
        ? await this.options.git.exportRepository()
        : undefined;
    return {
      project: await this.collectProject(),
      ...(repository ? { repository } : {}),
      sessions: await this.collectSessions(),
      artifacts: await this.collectArtifacts(),
    };
  }

  private async restoreBackup(backup: {
    project: WorkspaceBundle;
    repository?: Uint8Array;
    sessions: SessionSnapshot[];
    artifacts: WorkspaceArtifactRecord[];
  }): Promise<void> {
    await this.materializeProject(backup.project, true);
    if (backup.repository && this.options.git?.importRepository) {
      if (await this.options.vfs.stat('.git')) {
        await this.options.vfs.remove('.git', { recursive: true });
      }
      await this.options.git.importRepository(backup.repository);
    }
    if (this.options.sessions) {
      for (const session of backup.sessions) {
        await this.options.sessions.save(session);
      }
    }
    await this.restoreArtifacts(backup.artifacts);
  }
}

export function reconcileSession(
  input: SessionSnapshot,
  environmentChanged: boolean,
  environmentId: string,
  now: number
): SessionSnapshot {
  const snapshot = cloneSnapshot(input);
  const wasActive =
    snapshot.taskStatus === 'queued' ||
    snapshot.taskStatus === 'running' ||
    snapshot.taskStatus === 'waiting';
  if (wasActive) snapshot.taskStatus = 'paused';
  snapshot.tasks = (snapshot.tasks ?? []).map((task) => ({
    ...task,
    status:
      task.status === 'queued' ||
      task.status === 'running' ||
      task.status === 'waiting'
        ? 'paused'
        : task.status,
    lease: undefined,
    updatedAt: now,
  }));
  snapshot.rows = snapshot.rows.map((row) =>
    row.status === 'pending' || row.status === 'streaming'
      ? { ...row, status: 'cancelled', completedAt: now }
      : row
  );
  snapshot.children = (snapshot.children ?? []).map((child) =>
    child.status === 'queued' || child.status === 'running'
      ? { ...child, status: 'cancelled', updatedAt: now }
      : child
  );
  snapshot.permission = snapshot.permission
    ? {
        mode: 'guarded',
        ...(snapshot.permission.plan ? { plan: snapshot.permission.plan } : {}),
      }
    : undefined;
  snapshot.revision += 1;
  snapshot.eventSeq += 1;
  snapshot.events.push({
    seq: snapshot.eventSeq,
    type: 'workspace.resumed',
    revision: snapshot.revision,
    occurredAt: now,
    payload: {
      environmentChanged,
      environmentId,
      interrupted: wasActive,
    },
  });
  return snapshot;
}

function mergeActionRequirements(
  base: WorkspaceEnvironmentManifest['requiredActions'],
  overlay: WorkspaceEnvironmentManifest['requiredActions']
): WorkspaceEnvironmentManifest['requiredActions'] {
  const merged = new Map<string, WorkspaceEnvironmentManifest['requiredActions'][number]>();
  for (const requirement of [...base, ...overlay]) {
    const existing = merged.get(requirement.id);
    merged.set(requirement.id, {
      ...existing,
      ...requirement,
      required: Boolean(existing?.required || requirement.required),
      ...(requirement.versionRange ?? existing?.versionRange
        ? { versionRange: requirement.versionRange ?? existing?.versionRange }
        : {}),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
}
