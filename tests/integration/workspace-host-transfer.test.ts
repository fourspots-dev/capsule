import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { HostArtifactStore } from '../../src/adapters/host-artifact-store';
import { HostSessionStore } from '../../src/adapters/host-session-store';
import { createHostActionTools } from '../../src/adapters/host-action-tools';
import { createVirtualWorkspaceTools } from '../../src/adapters/virtual-workspace-tools';
import {
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
} from '../../src/core';
import { PermissionModeRegistry } from '../../src/core/policy';
import { PortableGitBackend } from '../../src/git/backend';
import type { HostBridge } from '../../src/host';
import { NodeHostFileSystem } from '../../src/node/host-fs';
import { NodeHostBridge } from '../../src/node/node-host';
import { HostActionRegistry } from '../../src/platform/host-action';
import { VirtualWorkspace } from '../../src/virtual';
import { WorkspaceContinuityService } from '../../src/workspace/continuity';
import {
  FakeApproval,
  FakeClock,
  FakeModelTransport,
  text,
} from '../harness/fakes';
import { command } from '../harness/workspace';

const roots: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('cross-host workspace transfer', () => {
  it('exports and imports from two Node hosts, then resumes the same session', async () => {
    const sourceRoot = await workspaceRoot('source');
    const targetRoot = await workspaceRoot('target');
    let capsuleBytes: Uint8Array | undefined;
    const sourceHost = transferHost(
      new NodeHostBridge({
        id: 'source-host',
        projectRoot: sourceRoot,
        stateRoot: join(sourceRoot, '.tinyai'),
      }),
      {
        exportWorkspace: async (data) => {
          capsuleBytes = new Uint8Array(data);
        },
        importWorkspace: async () => undefined,
      }
    );
    const sourceFs = new NodeHostFileSystem(sourceRoot, () => 1_700_000_000_000);
    const sourceGit = new PortableGitBackend(sourceFs, {
      now: () => 1_700_000_000_000,
    });
    const sourceSessions = new HostSessionStore(sourceHost.storage);
    const sourceArtifacts = new HostArtifactStore(sourceHost.storage);
    await sourceGit.init({ initialBranch: 'main' });
    await sourceFs.write('src/ship.js', encoder.encode('ship ready\n'));
    await sourceGit.add(['.']);
    await sourceGit.commit({ message: 'source ship' });
    await sourceSessions.save(activeSession());
    await sourceArtifacts.put({
      name: 'source.log',
      mimeType: 'text/plain',
      kind: 'log',
      sessionId: 'session_transfer',
      data: encoder.encode('source evidence'),
    });
    const sourceContinuity = new WorkspaceContinuityService({
      workspaceId: 'transfer-workspace',
      generation: 4,
      vfs: sourceFs,
      git: sourceGit,
      sessions: sourceSessions,
      artifacts: sourceArtifacts,
      environmentId: 'source-node',
      hostProfile: 'local-coding',
      environment: environment(),
    });
    await sourceContinuity.transferToHost(sourceHost);
    expect(capsuleBytes).toBeDefined();

    const targetHost = transferHost(
      new NodeHostBridge({
        id: 'target-host',
        projectRoot: targetRoot,
        stateRoot: join(targetRoot, '.tinyai'),
      }),
      {
        exportWorkspace: async () => undefined,
        importWorkspace: async () => capsuleBytes,
      }
    );
    const targetFs = new NodeHostFileSystem(targetRoot, () => 1_800_000_000_000);
    const targetGit = new PortableGitBackend(targetFs, {
      now: () => 1_800_000_000_000,
    });
    const targetSessions = new HostSessionStore(targetHost.storage);
    const targetArtifacts = new HostArtifactStore(targetHost.storage);
    const targetContinuity = new WorkspaceContinuityService({
      workspaceId: 'transfer-workspace',
      generation: 4,
      vfs: targetFs,
      git: targetGit,
      sessions: targetSessions,
      artifacts: targetArtifacts,
      environmentId: 'target-node',
      hostProfile: 'local-coding',
      environment: environment(),
    });
    const imported = await targetContinuity.importFromHost(targetHost, {
      replaceProject: true,
    });
    expect(imported).toMatchObject({
      sessions: ['session_transfer'],
      environmentChanged: true,
    });
    expect(decoder.decode(await targetFs.read('src/ship.js'))).toBe('ship ready\n');
    expect(await targetGit.log()).toMatchObject([{ message: 'source ship\n' }]);
    const restored = await targetSessions.load('session_transfer');
    expect(restored).toMatchObject({
      taskStatus: 'paused',
      permission: { mode: 'guarded' },
    });

    const workspace = new VirtualWorkspace({
      host: targetHost,
      vfs: targetFs,
      storageKey: 'target-workspace',
    });
    const actionTools = await createHostActionTools(new HostActionRegistry());
    const tools = new ToolExecutor(
      [...createVirtualWorkspaceTools(workspace), ...actionTools],
      new FakeApproval(true)
    );
    const model = new FakeModelTransport(async function* () {
      yield* text('continued on target host');
    });
    const runtime = new WorkspaceRuntime({
      model,
      tools,
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
      sessionStore: targetSessions,
      permissionModes: new PermissionModeRegistry('guarded'),
    });
    await runtime.command(command('session_transfer', 'continue', 'Continue the task.'));
    await runtime.waitForSessionIdle('session_transfer');
    expect(runtime.getProjection('session_transfer')).toMatchObject({
      rows: expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: 'continued on target host',
        }),
      ]),
    });
    expect(model.requests[0].messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: expect.stringContaining('Build the ship'),
        }),
      ])
    );
  });
});

function transferHost(
  host: NodeHostBridge,
  workspace: NonNullable<HostBridge['workspace']>
): HostBridge & { storage: NonNullable<HostBridge['storage']> } {
  return {
    storage: host.storage,
    clock: host.clock,
    scheduler: host.scheduler,
    crypto: host.crypto,
    clone: host.clone,
    descriptor: {
      ...host.descriptor,
      capabilities: [
        ...host.descriptor.capabilities.filter(
          (capability) =>
            capability !== 'workspace.import' && capability !== 'workspace.export'
        ),
        'workspace.import',
        'workspace.export',
      ],
    },
    workspace,
    ...(host.terminal ? { terminal: host.terminal } : {}),
    ...(host.process ? { process: host.process } : {}),
    ...(host.actions ? { actions: host.actions } : {}),
  };
}

async function workspaceRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `tinyai-${label}-`));
  roots.push(root);
  return root;
}

function environment() {
  return {
    manifestVersion: 1 as const,
    requiredActions: [],
    requiredCapabilities: ['filesystem', 'git'],
  };
}

function activeSession() {
  return {
    schemaVersion: 1 as const,
    sessionId: 'session_transfer',
    logEpoch: 'epoch_transfer',
    revision: 3,
    eventSeq: 3,
    taskStatus: 'running' as const,
    messages: [
      { role: 'user' as const, content: 'Build the ship.' },
      { role: 'assistant' as const, content: 'Ship implementation started.' },
    ],
    rows: [
      {
        id: 'u1',
        entityId: 'i1',
        productTurnId: 't1',
        kind: 'user' as const,
        text: 'Build the ship.',
        status: 'completed' as const,
      },
      {
        id: 'a1',
        entityId: 'm1',
        productTurnId: 't1',
        kind: 'assistant' as const,
        text: 'Ship implementation started.',
        status: 'streaming' as const,
      },
    ],
    ledger: [],
    events: [],
    permission: { mode: 'build' as const },
  };
}
