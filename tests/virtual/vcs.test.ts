import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, SnapshotVcs } from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('SnapshotVcs', () => {
  it('creates deterministic snapshots, diffs and restores files', async () => {
    const vfs = new MemoryFileSystem(() => 10);
    await vfs.write('src/a.ts', encoder.encode('export const a = 1;\n'));
    const vcs = new SnapshotVcs(vfs, () => 20);
    const first = await vcs.commit('initial');
    await vfs.write('src/a.ts', encoder.encode('export const a = 2;\n'));
    await vfs.write('src/b.ts', encoder.encode('export const b = 3;\n'));
    const second = await vcs.commit('feature');

    const diff = await vcs.diff(first.id, second.id);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'src/a.ts',
          status: 'modified',
          patch: expect.stringContaining('-export const a = 1;'),
        }),
        expect.objectContaining({
          path: 'src/b.ts',
          status: 'added',
        }),
      ])
    );

    await vcs.restore(first.id);
    expect(decoder.decode(await vfs.read('src/a.ts'))).toBe(
      'export const a = 1;\n'
    );
    expect(await vfs.stat('src/b.ts')).toBeUndefined();
    expect(vcs.headId).toBe(first.id);
  });

  it('exports isolated overlay changes and applies them explicitly', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('base.txt', encoder.encode('base'));
    const vcs = new SnapshotVcs(vfs);
    await vcs.commit('base');
    const fork = vcs.fork();
    await fork.write('base.txt', encoder.encode('child'));
    await fork.write('new.txt', encoder.encode('new'));
    await fork.remove('base.txt');
    await fork.write('base.txt', encoder.encode('child'));
    const changes = await fork.changes();

    expect(decoder.decode(await vfs.read('base.txt'))).toBe('base');
    await vcs.applyChanges(changes);
    expect(decoder.decode(await vfs.read('base.txt'))).toBe('child');
    expect(decoder.decode(await vfs.read('new.txt'))).toBe('new');
  });

  it('marks binary changes without generating text patches', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('image.bin', new Uint8Array([0, 255, 1]));
    const vcs = new SnapshotVcs(vfs);
    const first = await vcs.commit('one');
    await vfs.write('image.bin', new Uint8Array([0, 255, 2]));
    const second = await vcs.commit('two');
    expect((await vcs.diff(first.id, second.id)).files[0]).toEqual({
      path: 'image.bin',
      status: 'binary',
    });
  });
});
