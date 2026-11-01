import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceCapsule,
  CAPSULE_V2_MAGIC,
  encodeWorkspaceCapsuleV2Chunks,
  parseWorkspaceCapsuleAuto,
  parseWorkspaceCapsuleV2,
  serializeWorkspaceCapsule,
  serializeWorkspaceCapsuleV2,
} from '../../src/workspace';
import type { WorkspaceCapsulePartitions } from '../../src/workspace';
import { createWorkspaceBundle } from '../../src/virtual';

describe('REQ-WORKSPACE-002 Capsule v2 codec', () => {
  it('round-trips compressed chunked content-addressed partitions', async () => {
    const capsule = await capsuleFixture();
    const bytes = await serializeWorkspaceCapsuleV2(capsule, {
      chunkBytes: 64,
    });
    expect([...bytes.slice(0, CAPSULE_V2_MAGIC.byteLength)]).toEqual([
      ...CAPSULE_V2_MAGIC,
    ]);
    const parsed = await parseWorkspaceCapsuleV2(bytes);
    expect(parsed.manifest).toEqual(capsule.manifest);
    expect(parsed.partitions.project).toEqual(capsule.partitions.project);
    expect(parsed.partitions.evidence).toEqual(capsule.partitions.evidence);
    expect(bytes.byteLength).toBeLessThan(
      serializeWorkspaceCapsule(capsule).byteLength
    );
  });

  it('streams multiple encoded chunks and remains compatible with v1 input', async () => {
    const capsule = await capsuleFixture();
    const chunks: Uint8Array[] = [];
    for await (const chunk of encodeWorkspaceCapsuleV2Chunks(capsule, {
      chunkBytes: 32,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(2);
    const concatenated = concat(chunks);
    expect((await parseWorkspaceCapsuleAuto(concatenated)).manifest.workspaceId).toBe(
      'workspace_v2'
    );
    expect(
      (await parseWorkspaceCapsuleAuto(serializeWorkspaceCapsule(capsule)))
        .manifest.workspaceId
    ).toBe('workspace_v2');
  });

  it('rejects tampered chunks before importing partitions', async () => {
    const capsule = await capsuleFixture();
    const bytes = await serializeWorkspaceCapsuleV2(capsule, {
      chunkBytes: 64,
    });
    const tampered = new Uint8Array(bytes);
    tampered[tampered.byteLength - 1] ^= 0xff;
    await expect(parseWorkspaceCapsuleV2(tampered)).rejects.toMatchObject({
      code: 'CAPSULE_INVALID',
    });
  });
});

async function capsuleFixture() {
  const repeated = 'content-addressed-capsule-'.repeat(200);
  const partitions: WorkspaceCapsulePartitions = {
    project: createWorkspaceBundle({
      files: [
        {
          path: 'src/large.txt',
          dataBase64: btoa(repeated),
        },
      ],
      directories: ['src'],
    }),
    agentState: { sessions: [] },
    artifacts: { records: [] },
    evidence: {
      records: [
        {
          id: 'evidence_1',
          sessionId: 'session',
          taskId: 'task',
          workspaceGeneration: 1,
          environmentFingerprint: 'env',
          action: { id: 'app.tests', version: '1.0.0' },
          fileHashes: {},
          report: {
            schemaVersion: 1,
            runner: 'vitest',
            total: 1,
            passed: 1,
            failed: 0,
            skipped: 0,
            failures: [],
          },
          status: 'current',
          artifactIds: [],
          createdAt: 1,
        },
      ],
    },
    environment: {
      manifestVersion: 1,
      requiredActions: [],
      requiredCapabilities: ['filesystem'],
    },
  };
  return buildWorkspaceCapsule({
    capsuleId: 'capsule_v2',
    workspaceId: 'workspace_v2',
    generation: 1,
    createdAt: 1,
    producer: {
      agentVersion: '0.7.0',
      hostProfile: 'test',
      environmentId: 'env',
    },
    partitions,
  });
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
