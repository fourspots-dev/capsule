import { describe, expect, it } from 'vitest';
import {
  createWorkspaceBundle,
  importWorkspaceBundle,
  MemoryFileSystem,
  MemoryKeyValueStore,
  WorkspaceSyncService,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('WorkspaceSyncService', () => {
  it('detects concurrent local and external edits and resets the baseline after sync', async () => {
    const vfs = new MemoryFileSystem();
    const storage = new MemoryKeyValueStore();
    const baseline = bundle({
      'a.txt': 'a-base',
      'b.txt': 'b-base',
    });
    await importWorkspaceBundle(vfs, baseline);
    const sync = new WorkspaceSyncService(vfs, {
      storage,
      storageKey: 'sync:test',
    });
    await sync.captureBaseline(baseline);
    await vfs.write('a.txt', encoder.encode('a-local'));

    const external = bundle({
      'a.txt': 'a-external',
      'b.txt': 'b-external',
      'c.txt': 'c-new',
    });
    expect(await sync.inspect(external)).toEqual({
      changes: [
        { path: 'a.txt', status: 'modified' },
        { path: 'b.txt', status: 'modified' },
        { path: 'c.txt', status: 'added' },
      ],
      conflicts: [
        expect.objectContaining({
          path: 'a.txt',
          baselineHash: expect.any(String),
          localHash: expect.any(String),
          externalHash: expect.any(String),
        }),
      ],
    });
    await expect(sync.apply(external)).rejects.toMatchObject({
      code: 'WORKSPACE_SYNC_CONFLICT',
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('a-local');

    await sync.apply(external, { strategy: 'ours' });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('a-local');
    expect(decoder.decode(await vfs.read('b.txt'))).toBe('b-external');
    expect(decoder.decode(await vfs.read('c.txt'))).toBe('c-new');

    const reopened = new WorkspaceSyncService(vfs, {
      storage,
      storageKey: 'sync:test',
    });
    expect(await reopened.inspect(external)).toEqual({
      changes: [],
      conflicts: [],
    });
  });

  it('applies external deletions and can prefer the external version', async () => {
    const vfs = new MemoryFileSystem();
    const baseline = bundle({ 'a.txt': 'base', 'b.txt': 'keep' });
    await importWorkspaceBundle(vfs, baseline);
    const sync = new WorkspaceSyncService(vfs);
    await sync.captureBaseline(baseline);
    await vfs.write('a.txt', encoder.encode('local'));
    const external = bundle({ 'a.txt': 'external' });
    const preview = await sync.apply(external, { strategy: 'theirs' });
    expect(preview.conflicts).toHaveLength(1);
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('external');
    expect(await vfs.stat('b.txt')).toBeUndefined();
  });
});

function bundle(files: Record<string, string>) {
  return createWorkspaceBundle({
    files: Object.entries(files).map(([path, value]) => ({
      path,
      dataBase64: btoa(value),
    })),
  });
}
