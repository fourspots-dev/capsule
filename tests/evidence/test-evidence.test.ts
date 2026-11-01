import { describe, expect, it } from 'vitest';
import { InMemoryArtifactStore } from '../../src/core/artifact-store';
import { InMemoryEvidenceStore } from '../../src/core/evidence-store';
import {
  TestEvidenceService,
  createTestEvidenceCompletionGuard,
} from '../../src/evidence';
import { MemoryFileSystem } from '../../src/virtual';

describe('REQ-TEST-001 TestEvidence lifecycle', () => {
  it('creates current evidence and marks it stale after a workspace change', async () => {
    const fixture = evidenceFixture();
    await fixture.vfs.write('src/value.ts', new TextEncoder().encode('one'));
    const record = await fixture.service.recordActionTest({
      sessionId: 'session',
      taskId: 'task',
      action: { id: 'app.test', version: '1.0.0' },
      runner: 'vitest',
      result: {
        status: 'succeeded',
        value: {
          total: 2,
          passed: 2,
          failed: 0,
          skipped: 0,
          failures: [],
        },
      },
    });
    expect(record).toMatchObject({
      status: 'current',
      report: { total: 2, passed: 2, failed: 0 },
      workspaceGeneration: 1,
      environmentFingerprint: 'env-a',
      fileHashes: { 'src/value.ts': expect.any(String) },
    });

    await fixture.vfs.write('src/value.ts', new TextEncoder().encode('two'));
    expect(await fixture.service.refresh(record)).toMatchObject({
      status: 'stale',
      reason: expect.stringContaining('file changed'),
    });
  });

  it('preserves failure artifacts and invalidates failures without artifacts', async () => {
    const fixture = evidenceFixture();
    const failed = await fixture.service.recordActionTest({
      sessionId: 'session',
      taskId: 'task',
      action: { id: 'app.test', version: '1.0.0' },
      runner: 'vitest',
      result: {
        status: 'failed',
        value: {
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          failures: [{ name: 'case' }],
        },
      },
    });
    expect(failed).toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining('no failure Artifact'),
    });

    const withArtifact = await fixture.service.recordActionTest({
      sessionId: 'session',
      taskId: 'task',
      action: { id: 'app.test', version: '1.0.0' },
      runner: 'vitest',
      result: {
        status: 'failed',
        value: {
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          failures: [{ name: 'case' }],
        },
        artifacts: [
          {
            name: 'failure.log',
            mimeType: 'text/plain',
            kind: 'log',
            data: new TextEncoder().encode('failure'),
          },
        ],
      },
    });
    expect(withArtifact.status).toBe('failed');
    expect(withArtifact.artifactIds).toHaveLength(1);
    expect(await fixture.artifacts.list()).toHaveLength(1);
  });

  it('blocks completion when evidence is missing, stale, old or zero-test', async () => {
    const fixture = evidenceFixture();
    const guard = createTestEvidenceCompletionGuard({
      service: fixture.service,
      store: fixture.store,
      actionVersions: async () => '1.0.0',
    });
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: { rows: [] },
      })
    ).toMatchObject({ ok: false, reason: expect.stringContaining('No TestEvidence') });

    const record = await fixture.service.recordActionTest({
      sessionId: 'session',
      taskId: 'task',
      action: { id: 'app.test', version: '1.0.0' },
      runner: 'script',
      result: { status: 'succeeded', value: { passed: true } },
    });
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: { rows: [] },
      })
    ).toEqual({ ok: true });

    record.createdAt = 10;
    await fixture.store.save(record);
    expect(
      await guard({
        sessionId: 'session',
        taskId: 'task',
        view: {
          rows: [
            {
              kind: 'tool',
              status: 'completed',
              toolName: 'write_file',
              completedAt: 20,
            },
          ],
        },
      })
    ).toMatchObject({
      ok: false,
      reason: expect.stringContaining('Workspace changed'),
    });
  });
});

function evidenceFixture() {
  const vfs = new MemoryFileSystem(() => 10);
  const store = new InMemoryEvidenceStore();
  const artifacts = new InMemoryArtifactStore(() => 10);
  let generation = 1;
  const service = new TestEvidenceService({
    store,
    artifacts,
    vfs,
    environmentFingerprint: 'env-a',
    workspaceGeneration: () => generation,
    now: () => 10,
    newId: () => `evidence_${Math.random().toString(36).slice(2)}`,
  });
  return {
    vfs,
    store,
    artifacts,
    service,
    setGeneration(value: number) {
      generation = value;
    },
  };
}
