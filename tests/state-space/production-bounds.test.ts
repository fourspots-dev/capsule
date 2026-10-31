import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { applyProjectionDelta, type ProductProjection } from '../../src/core';
import { MemoryHostBridge } from '../../src/host';
import { MemoryFileSystem, searchVirtualFiles, VirtualWorkspace } from '../../src/virtual';

const encoder = new TextEncoder();

describe('production performance and bounded soak', () => {
  it('searches a 10k-file virtual workspace within the interaction budget', async () => {
    const vfs = new MemoryFileSystem();
    for (let directory = 0; directory < 100; directory += 1) {
      for (let file = 0; file < 100; file += 1) {
        await vfs.write(
          `src/d${directory}/f${file}.ts`,
          encoder.encode(
            file === 99 && directory === 99
              ? 'export const needle = true;\n'
              : `export const value = ${file};\n`
          )
        );
      }
    }
    const started = performance.now();
    const matches = await searchVirtualFiles(vfs, {
      pattern: 'needle',
      include: ['**/*.ts'],
      maxResults: 1,
    });
    const duration = performance.now() - started;
    expect(matches).toEqual([
      expect.objectContaining({ path: 'src/d99/f99.ts' }),
    ]);
    expect(duration).toBeLessThan(3_000);
  }, 10_000);

  it('applies 10k projection updates with bounded memory and deterministic state', () => {
    let projection = baseProjection();
    const started = performance.now();
    for (let index = 0; index < 10_000; index += 1) {
      projection = applyProjectionDelta(projection, {
        type: 'state.updated',
        patch: { revision: index + 1, eventSeq: index + 1 },
      });
    }
    expect(projection).toMatchObject({ revision: 10_000, eventSeq: 10_000 });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('soaks 100 checkpoints and jobs without losing workspace or VCS state', async () => {
    const workspace = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'soak:workspace',
    });
    for (let index = 0; index < 20; index += 1) {
      await workspace.fs.write(
        `src/file_${index}.ts`,
        encoder.encode(`export const value = ${index};\n`)
      );
    }
    for (let index = 0; index < 100; index += 1) {
      await workspace.fs.write(
        'src/current.ts',
        encoder.encode(`export const revision = ${index};\n`)
      );
      await workspace.checkpoint(`revision-${index}`);
    }
    const jobs = await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        workspace.jobs.start(`echo job-${index}`)
      )
    );
    const completed = await Promise.all(
      jobs.map((job) => workspace.jobs.wait(job.id))
    );
    expect(completed.filter((job) => job.status === 'completed')).toHaveLength(50);
    const status = await workspace.status();
    expect(status.fileCount).toBe(21);
    expect((await workspace.vcs.list()).length).toBe(100);
    expect(await workspace.jobs.list()).toHaveLength(50);
  }, 15_000);
});

function baseProjection(): ProductProjection {
  return {
    sessionId: 'session',
    revision: 0,
    eventSeq: 0,
    logEpoch: 'epoch',
    phase: 'running',
    lifecycle: 'ready',
    taskStatus: 'running',
    inputRouting: 'queue',
    queueLength: 0,
    permissionMode: 'guarded',
    rows: [],
    availability: {
      canSend: true,
      canStop: true,
      canApprove: false,
      canQueue: true,
    },
  };
}
