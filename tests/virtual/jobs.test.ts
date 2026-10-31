import { describe, expect, it } from 'vitest';
import {
  MemoryFileSystem,
  MemoryKeyValueStore,
  VirtualJobManager,
  VirtualShell,
  type VirtualCommandProvider,
} from '../../src/virtual';
import { until } from '../harness/fakes';

function delayedProvider() {
  const pending: Array<{
    reject(error: Error): void;
    resolve(): void;
  }> = [];
  const provider: VirtualCommandProvider = {
    canExecute: (command) => command === 'slow',
    execute: async (request) => {
      if (request.signal?.aborted) throw abortError();
      await new Promise<void>((resolve, reject) => {
        pending.push({ resolve, reject });
        request.signal?.addEventListener(
          'abort',
          () => reject(abortError()),
          { once: true }
        );
      });
      return { exitCode: 0, stdout: 'slow done\n', stderr: '' };
    },
  };
  return {
    provider,
    release() {
      pending.shift()?.resolve();
    },
    size: () => pending.length,
  };
}

describe('VirtualJobManager', () => {
  it('runs commands in the background, exposes completion and respects cancellation', async () => {
    const delayed = delayedProvider();
    const manager = new VirtualJobManager(
      new VirtualShell(new MemoryFileSystem(), { providers: [delayed.provider] }),
      { now: () => 10 }
    );
    const job = await manager.start('slow');
    await until(() => delayed.size() === 1);
    expect(await manager.read(job.id)).toMatchObject({
      status: 'running',
      script: 'slow',
    });
    delayed.release();
    await expect(manager.wait(job.id)).resolves.toMatchObject({
      status: 'completed',
      stdout: 'slow done\n',
      exitCode: 0,
    });

    const second = await manager.start('slow');
    await until(() => delayed.size() === 1);
    await manager.cancel(second.id);
    await expect(manager.wait(second.id)).resolves.toMatchObject({
      status: 'cancelled',
      exitCode: 130,
    });
    await manager.dispose();
  });

  it('persists jobs and marks interrupted work without replaying it', async () => {
    const storage = new MemoryKeyValueStore();
    await storage.set('jobs:test', {
      schemaVersion: 1,
      jobs: [
        {
          id: 'job_running',
          script: 'slow',
          cwd: '',
          status: 'running',
          createdAt: 1,
          startedAt: 2,
          stdout: 'partial',
          stderr: '',
        },
      ],
    });
    const provider = delayedProvider();
    const manager = new VirtualJobManager(
      new VirtualShell(new MemoryFileSystem(), { providers: [provider.provider] }),
      {
        storage,
        storageKey: 'jobs:test',
        now: () => 20,
      }
    );
    expect(await manager.list()).toEqual([
      expect.objectContaining({
        id: 'job_running',
        status: 'interrupted',
        stdout: 'partial',
        completedAt: 20,
      }),
    ]);
    expect(provider.size()).toBe(0);
  });

  it('queues work at the concurrency limit', async () => {
    const delayed = delayedProvider();
    const manager = new VirtualJobManager(
      new VirtualShell(new MemoryFileSystem(), { providers: [delayed.provider] }),
      { maxConcurrent: 1 }
    );
    const first = await manager.start('slow');
    const second = await manager.start('slow');
    await until(() => delayed.size() === 1);
    expect(await manager.read(second.id)).toMatchObject({ status: 'queued' });
    delayed.release();
    await manager.wait(first.id);
    await until(() => delayed.size() === 1);
    expect(await manager.read(second.id)).toMatchObject({ status: 'running' });
    delayed.release();
    await manager.wait(second.id);
  });
});

function abortError(): Error {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}
