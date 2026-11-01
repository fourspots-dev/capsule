import { describe, expect, it } from 'vitest';
import { createHostActionTools } from '../../src/adapters/host-action-tools';
import { InMemoryArtifactStore } from '../../src/core/artifact-store';
import { InMemoryEvidenceStore } from '../../src/core/evidence-store';
import { ToolExecutor } from '../../src/core/tool-executor';
import { HostActionRegistry } from '../../src/platform/host-action';
import {
  TestEvidenceService,
  createTestEvidenceCompletionGuard,
} from '../../src/evidence';
import { MemoryFileSystem } from '../../src/virtual';
import { FakeApproval } from '../harness/fakes';

describe('REQ-TEST-001 Action to completion evidence integration', () => {
  it('records current evidence and blocks completion after files change', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('src/index.ts', new TextEncoder().encode('export const x = 1;\n'));
    const evidenceStore = new InMemoryEvidenceStore();
    const artifacts = new InMemoryArtifactStore();
    let generation = 1;
    let version = '1.0.0';
    const evidence = new TestEvidenceService({
      store: evidenceStore,
      artifacts,
      vfs,
      environmentFingerprint: 'env-a',
      workspaceGeneration: () => generation,
      now: () => 10,
      newId: () => 'evidence_1',
    });
    const registry = new HostActionRegistry();
    registry.register('app', {
      describe: async () => [
        {
          id: 'app.tests.run',
          version,
          title: 'Run tests',
          description: 'Run tests.',
          inputSchema: { type: 'object', properties: {} },
          effects: ['execute'],
          risk: 'read',
          test: { runner: 'vitest' },
          probe: async () => ({ state: 'available' }),
        },
      ],
      invoke: async () => ({
        value: {
          total: 2,
          passed: 2,
          failed: 0,
          skipped: 0,
          failures: [],
        },
        status: 'succeeded',
      }),
    });
    const tools = await createHostActionTools(registry, { testEvidence: evidence });
    const executor = new ToolExecutor(tools, new FakeApproval(true), {
      artifacts: { store: artifacts },
    });
    const result = await executor.execute({
      sessionId: 'session',
      taskId: 'task',
      call: {
        id: 'call',
        name: 'action_app_tests_run',
        arguments: '{}',
      },
      signal: new AbortController().signal,
    });
    expect(result.metadata?.evidence).toMatchObject({
      id: 'evidence_1',
      status: 'current',
    });
    const guard = createTestEvidenceCompletionGuard({
      service: evidence,
      store: evidenceStore,
      actionVersions: async () => version,
    });
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: { rows: [] },
      })
    ).toEqual({ ok: true });

    generation = 2;
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: { rows: [] },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Workspace generation changed'),
    });

    generation = 1;
    const [currentRecord] = await evidenceStore.list({
      sessionId: 'session',
      taskId: 'task',
    });
    currentRecord.status = 'current';
    delete currentRecord.reason;
    await evidenceStore.save(currentRecord);
    version = '1.1.0';
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: { rows: [] },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Action version changed'),
    });
  });

  it('binds child Action evidence to the child VFS and generation', async () => {
    const rootVfs = new MemoryFileSystem();
    const childVfs = new MemoryFileSystem();
    await rootVfs.write('root.txt', new TextEncoder().encode('root'));
    await childVfs.write('child.txt', new TextEncoder().encode('child'));
    const evidenceStore = new InMemoryEvidenceStore();
    const evidence = new TestEvidenceService({
      store: evidenceStore,
      artifacts: new InMemoryArtifactStore(),
      vfs: rootVfs,
      environmentFingerprint: 'env',
      workspaceGeneration: () => 1,
      now: () => 10,
      newId: () => 'evidence_child',
    });
    const registry = new HostActionRegistry();
    registry.register('app', {
      describe: async () => [
        {
          id: 'app.tests.run',
          version: '1.0.0',
          title: 'Run tests',
          description: 'Run tests.',
          inputSchema: { type: 'object', properties: {} },
          effects: ['execute'],
          risk: 'read',
          workspaceBinding: 'fork',
          test: { runner: 'vitest' },
          probe: async () => ({ state: 'available' }),
        },
      ],
      invoke: async () => ({
        value: { total: 1, passed: 1, failed: 0, skipped: 0, failures: [] },
        status: 'succeeded',
      }),
    });
    const tools = await createHostActionTools(registry, {
      testEvidence: evidence,
      bindingForInvocation: () => ({
        workspaceId: 'child_workspace',
        workspaceGeneration: 9,
        evidenceVfs: childVfs,
      }),
    });
    const executor = new ToolExecutor(tools, new FakeApproval(true));
    await executor.execute({
      sessionId: 'child_session',
      taskId: 'child_task',
      call: {
        id: 'call_child',
        name: 'action_app_tests_run',
        arguments: '{}',
      },
      signal: new AbortController().signal,
    });
    expect(await evidenceStore.list()).toMatchObject([
      {
        id: 'evidence_child',
        sessionId: 'child_session',
        taskId: 'child_task',
        workspaceGeneration: 9,
        fileHashes: { 'child.txt': expect.any(String) },
      },
    ]);
  });
});
