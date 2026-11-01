import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../../src/core';
import { InMemoryEvidenceStore } from '../../src/core/evidence-store';
import { InMemorySessionStore } from '../../src/core/session-store';
import { HostWorkspaceImportJournal } from '../../src/adapters/host-workspace-import-journal';
import { PortableGitBackend } from '../../src/git/backend';
import { MemoryHostBridge } from '../../src/host';
import { createWorkspaceBundle, MemoryFileSystem } from '../../src/virtual';
import {
  WorkspaceContinuityService,
} from '../../src/workspace/continuity';

describe('REQ-WORKSPACE-002 interrupted import recovery', () => {
  it('persists a journal and restores the previous workspace on restart', async () => {
    const host = new MemoryHostBridge();
    const journal = new HostWorkspaceImportJournal(host.storage);
    const vfs = new MemoryFileSystem();
    const sessions = new InMemorySessionStore();
    const artifacts = new InMemoryArtifactStore();
    const evidence = new InMemoryEvidenceStore();
    const continuity = new WorkspaceContinuityService({
      workspaceId: 'workspace',
      vfs,
      git: new PortableGitBackend(vfs),
      sessions,
      artifacts,
      environmentId: 'env',
      hostProfile: 'test',
      agentVersion: '0.7.0',
      environment: {
        manifestVersion: 1,
        requiredActions: [],
        requiredCapabilities: ['filesystem'],
      },
      importJournal: journal,
      evidence: () => evidence.list(),
      restoreEvidence: async (records) => {
        for (const record of records) await evidence.save(record);
      },
    });

    const originalProject = createWorkspaceBundle({
      files: [
        {
          path: 'value.txt',
          dataBase64: btoa('original'),
        },
      ],
      directories: [],
    });
    const id = await journal.begin({
      project: originalProject,
      sessions: [],
      artifacts: [],
      evidence: [],
    });
    await journal.stage(id, 'project');
    await vfs.write('value.txt', new TextEncoder().encode('partial import'));

    const restartedJournal = new HostWorkspaceImportJournal(host.storage);
    const restarted = new WorkspaceContinuityService({
      workspaceId: 'workspace',
      vfs,
      git: new PortableGitBackend(vfs),
      sessions,
      artifacts,
      environmentId: 'env',
      hostProfile: 'test',
      agentVersion: '0.7.0',
      environment: {
        manifestVersion: 1,
        requiredActions: [],
        requiredCapabilities: ['filesystem'],
      },
      importJournal: restartedJournal,
      evidence: () => evidence.list(),
      restoreEvidence: async (records) => {
        for (const record of records) await evidence.save(record);
      },
    });
    expect(await restarted.recoverInterruptedImport()).toMatchObject({
      id,
      stage: 'project',
    });
    expect(new TextDecoder().decode(await vfs.read('value.txt'))).toBe(
      'original'
    );
    expect(await restartedJournal.pending()).toBeUndefined();
  });
});
