import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeHostFileSystem } from '../../src/node/host-fs';

describe('NodeHostFileSystem', () => {
  it('reads by byte range, writes atomically and rejects path escapes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-host-fs-'));
    try {
      await writeFile(join(root, 'value.txt'), '0123456789');
      const vfs = new NodeHostFileSystem(root, () => 10);
      expect(
        new TextDecoder().decode(await vfs.read('value.txt', { offset: 3, length: 4 }))
      ).toBe('3456');
      await vfs.write('nested/new.txt', new TextEncoder().encode('new'));
      expect(
        new TextDecoder().decode(await vfs.read('nested/new.txt'))
      ).toBe('new');
      expect((await vfs.list('', { recursive: true })).map((item) => item.path))
        .toEqual(['nested', 'nested/new.txt', 'value.txt']);
      await expect(vfs.write('.tinyai/host-state.json', new Uint8Array())).rejects
        .toMatchObject({ code: 'VFS_PATH_RESERVED' });
      await expect(vfs.read('../escape')).rejects.toMatchObject({
        code: 'VFS_PATH_INVALID',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not load a large sparse file for stat or bounded reads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-host-fs-large-'));
    try {
      await writeFile(join(root, 'large.bin'), '');
      await truncate(join(root, 'large.bin'), 32 * 1024 * 1024);
      const vfs = new NodeHostFileSystem(root);
      expect(await vfs.stat('large.bin')).toMatchObject({
        size: 32 * 1024 * 1024,
      });
      expect(
        (await vfs.read('large.bin', { offset: 1024, length: 16 })).byteLength
      ).toBe(16);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
