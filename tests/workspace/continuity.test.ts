import { describe, expect, it } from 'vitest';
import {
  InMemoryArtifactStore,
  InMemorySessionStore,
  type SessionSnapshot,
} from '../../src/core';
import { PortableGitBackend } from '../../src/git/backend';
import { MemoryHostBridge, type HostBridge } from '../../src/host';
import { MemoryFileSystem } from '../../src/virtual';
import {
  WorkspaceContinuityService,
} from '../../src/workspace/continuity';
import {
  parseWorkspaceCapsule,
  serializeWorkspaceCapsule,
} from '../../src/workspace/codec';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('WorkspaceContinuityService', () => {
  it('round-trips project, Git, sessions, artifacts and recovery state', async () => {
    const source = await sourceFixture();
    const capsule = await source.service.exportCapsule();
    const parsed = await parseWorkspaceCapsule(serializeWorkspaceCapsule(capsule));
    expect(parsed.manifest).toMatchObject({
      workspaceId: 'game-workspace',
      generation: 3,
      producer: { environmentId: 'node-local-v1', hostProfile: 'local-coding' },
    });
    expect(parsed.manifest.partitions.project?.hash).toBeTruthy();
    expect(parsed.manifest.partitions.repository?.hash).toBeTruthy();

    const target = await emptyFixture('portable-v1');
    const prepared = await target.service.prepareImport(parsed);
    const result = await target.service.commitImport(prepared, {
      replaceProject: true,
    });
    expect(result).toMatchObject({
      workspaceId: 'game-workspace',
      generation: 4,
      sessions: ['session_game'],
      artifacts: 1,
      environmentChanged: true,
    });
    expect(decoder.decode(await target.vfs.read('src/game.js'))).toBe(
      'export const mode = "space";\n'
    );
    expect(await target.git.log()).toMatchObject([
      { message: 'initial 3d game\n' },
    ]);
    const restoredSession = await target.sessions.load('session_game');
    expect(restoredSession).toMatchObject({
      taskStatus: 'paused',
      permission: { mode: 'guarded', plan: 'Implement the game.' },
    });
    expect(restoredSession?.events.at(-1)).toMatchObject({
      type: 'workspace.resumed',
      payload: { environmentChanged: true, interrupted: true },
    });
    const artifacts = await target.artifacts.list();
    expect(artifacts).toHaveLength(1);
    expect(decoder.decode(await target.artifacts.read(artifacts[0].id))).toBe(
      'test report'
    );
    const reExported = await target.service.exportCapsule();
    expect(reExported.manifest.workspaceId).toBe('game-workspace');
    expect(reExported.partitions.environment.requiredActions).toEqual([
      {
        id: 'app.browser.run-tests',
        versionRange: '1.0.0',
        required: false,
      },
    ]);
  });

  it('moves a capsule through the host workspace bridge', async () => {
    const source = await sourceFixture();
    let transferred: Uint8Array | undefined;
    const host = hostWithWorkspace({
      exportWorkspace: async (data) => {
        transferred = new Uint8Array(data);
      },
      importWorkspace: async () => transferred,
    });
    await source.service.transferToHost(host);
    expect(transferred).toBeDefined();

    const target = await emptyFixture('portable-v1');
    const result = await target.service.importFromHost(host, {
      replaceProject: true,
    });
    expect(result.sessions).toEqual(['session_game']);
    expect(decoder.decode(await target.vfs.read('src/game.js'))).toContain(
      'space'
    );
  });

  it('rejects integrity failures before touching the destination', async () => {
    const source = await sourceFixture();
    const serialized = JSON.parse(
      decoder.decode(serializeWorkspaceCapsule(await source.service.exportCapsule()))
    ) as {
      partitions: { project: { files: Array<{ dataBase64: string }> } };
    };
    serialized.partitions.project.files[0].dataBase64 = btoa('tampered');
    const target = await emptyFixture('portable-v1');
    await target.vfs.write('keep.txt', encoder.encode('unchanged'));
    await expect(
      target.service.prepareImport(encoder.encode(JSON.stringify(serialized)))
    ).rejects.toMatchObject({ code: 'CAPSULE_INVALID' });
    expect(decoder.decode(await target.vfs.read('keep.txt'))).toBe('unchanged');
  });

  it('blocks required application actions that the destination lacks', async () => {
    const source = await sourceFixture(true);
    const capsule = await source.service.exportCapsule();
    const target = await emptyFixture('browser-v1');
    await expect(target.service.prepareImport(capsule)).rejects.toMatchObject({
      code: 'CAPSULE_ACTION_MISSING',
    });
  });
});

async function sourceFixture(requireBrowserAction = false) {
  const fixture = await emptyFixture('node-local-v1', requireBrowserAction);
  await fixture.git.init({ initialBranch: 'main' });
  await fixture.vfs.write(
    'src/game.js',
    encoder.encode('export const mode = "space";\n')
  );
  await fixture.git.add(['.']);
  await fixture.git.commit({ message: 'initial 3d game' });
  await fixture.sessions.save(sessionSnapshot());
  await fixture.artifacts.put({
    name: 'test-report.txt',
    mimeType: 'text/plain',
    kind: 'text',
    sessionId: 'session_game',
    data: encoder.encode('test report'),
  });
  return fixture;
}

async function emptyFixture(environmentId: string, requireBrowserAction = false) {
  const vfs = new MemoryFileSystem();
  const git = new PortableGitBackend(vfs, {
    now: () => 1_700_000_000_000,
  });
  const sessions = new InMemorySessionStore();
  const artifacts = new InMemoryArtifactStore();
  const service = new WorkspaceContinuityService({
    workspaceId: 'game-workspace',
    generation: 3,
    vfs,
    git,
    sessions,
    artifacts,
    environmentId,
    hostProfile: environmentId === 'node-local-v1' ? 'local-coding' : 'portable',
    now: () => 1_700_000_000_000,
    newId: () => 'capsule_game_1',
    environment: {
      manifestVersion: 1,
      requiredActions: [
        {
          id: 'app.browser.run-tests',
          versionRange: '1.0.0',
          required: requireBrowserAction,
        },
      ],
      requiredCapabilities: ['filesystem', 'git'],
    },
  });
  return { vfs, git, sessions, artifacts, service };
}

function sessionSnapshot(): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId: 'session_game',
    logEpoch: 'epoch_game',
    revision: 5,
    eventSeq: 5,
    taskStatus: 'running',
    messages: [
      { role: 'user', content: 'Build a 3D space combat game.' },
      { role: 'assistant', content: 'I am implementing the game.' },
    ],
    rows: [
      {
        id: 'row_user',
        entityId: 'input_1',
        productTurnId: 'task_1',
        kind: 'user',
        text: 'Build a 3D space combat game.',
        status: 'completed',
      },
      {
        id: 'row_assistant',
        entityId: 'message_1',
        productTurnId: 'task_1',
        kind: 'assistant',
        text: 'I am implementing the game.',
        status: 'streaming',
      },
    ],
    ledger: [],
    events: [],
    tasks: [
      {
        taskId: 'task_1',
        sessionId: 'session_game',
        status: 'running',
        revision: 1,
        budget: {},
        usage: { turns: 1, toolCalls: 1, tokens: 100 },
        children: [],
        createdAt: 1,
        updatedAt: 2,
      },
    ],
    permission: {
      mode: 'build',
      plan: 'Implement the game.',
      approvedAt: 10,
      approvedDigest: 'digest',
    },
  };
}

function hostWithWorkspace(
  workspace: NonNullable<HostBridge['workspace']>
): HostBridge {
  const base = new MemoryHostBridge();
  return {
    ...base,
    descriptor: {
      ...base.descriptor,
      capabilities: [
        ...base.descriptor.capabilities,
        'workspace.import',
        'workspace.export',
      ],
    },
    workspace,
  };
}
