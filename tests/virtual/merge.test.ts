import { describe, expect, it } from 'vitest';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('VirtualWorkspace fork and merge', () => {
  it('isolates child writes and applies a reviewed non-conflicting merge', async () => {
    const parent = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'merge:parent',
    });
    await parent.fs.write('src/a.ts', encoder.encode('export const a = 1;\n'));
    await parent.checkpoint('base');
    const child = await parent.fork();
    await child.fs.write('src/a.ts', encoder.encode('export const a = 2;\n'));
    await child.fs.write('src/b.ts', encoder.encode('export const b = 3;\n'));
    await child.fs.remove('missing.txt');

    expect(decoder.decode(await parent.fs.read('src/a.ts'))).toContain('= 1');
    expect(await parent.fs.stat('src/b.ts')).toBeUndefined();
    const preview = await parent.previewMerge(child);
    expect(preview.conflicts).toEqual([]);
    expect(preview.changes).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        status: 'modified',
        patch: expect.stringContaining('-export const a = 1;'),
      }),
      expect.objectContaining({
        path: 'src/b.ts',
        status: 'added',
      }),
    ]);
    await parent.applyMerge(child);
    expect(decoder.decode(await parent.fs.read('src/a.ts'))).toContain('= 2');
    expect(decoder.decode(await parent.fs.read('src/b.ts'))).toContain('= 3');
  });

  it('blocks conflicting merges and preserves parent state until explicit resolution', async () => {
    const parent = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'merge:conflict',
    });
    await parent.fs.write('a.txt', encoder.encode('base'));
    await parent.checkpoint('base');
    const child = await parent.fork();
    await child.fs.write('a.txt', encoder.encode('child'));
    await parent.fs.write('a.txt', encoder.encode('parent'));

    expect(await parent.previewMerge(child)).toMatchObject({
      conflicts: [
        expect.objectContaining({
          path: 'a.txt',
          reason: 'parent_changed',
        }),
      ],
    });
    await expect(parent.applyMerge(child)).rejects.toMatchObject({
      code: 'WORKSPACE_MERGE_CONFLICT',
    });
    expect(decoder.decode(await parent.fs.read('a.txt'))).toBe('parent');

    await parent.discardFork(child);
    expect(decoder.decode(await child.fs.read('a.txt'))).toBe('parent');
  });

  it('detects parent deletion conflicts for child modifications', async () => {
    const parent = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'merge:deleted',
    });
    await parent.fs.write('a.txt', encoder.encode('base'));
    const child = await parent.fork();
    await child.fs.write('a.txt', encoder.encode('child'));
    await parent.fs.remove('a.txt');
    expect(await parent.previewMerge(child)).toMatchObject({
      conflicts: [
        expect.objectContaining({
          path: 'a.txt',
          reason: 'parent_deleted',
        }),
      ],
    });
  });
});
