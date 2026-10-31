import { describe, expect, it } from 'vitest';
import {
  MemoryFileSystem,
  MemoryKeyValueStore,
  OverlayFileSystem,
  PersistentFileSystem,
  normalizeVirtualPath,
  type VirtualFileSystem,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const factories: Array<{
  name: string;
  create: () => {
    vfs: VirtualFileSystem;
    reopen?: () => VirtualFileSystem;
  };
}> = [
  {
    name: 'MemoryFS',
    create: () => ({ vfs: new MemoryFileSystem(() => 10) }),
  },
  {
    name: 'OverlayFS',
    create: () => ({
      vfs: new OverlayFileSystem(new MemoryFileSystem(() => 10), () => 20),
    }),
  },
  {
    name: 'PersistentFS',
    create: () => {
      const storage = new MemoryKeyValueStore();
      return {
        vfs: new PersistentFileSystem(storage, 'test:vfs', () => 10),
        reopen: () => new PersistentFileSystem(storage, 'test:vfs', () => 10),
      };
    },
  },
];

describe.each(factories)('$name contract', ({ create }) => {
  it('supports atomic writes, reads, listing, rename, copy and remove', async () => {
    const { vfs } = create();
    await vfs.mkdir('src', { recursive: true });
    const first = await vfs.write('src/a.txt', encoder.encode('hello'));
    expect(first).toMatchObject({ path: 'src/a.txt', kind: 'file', version: 1 });
    expect(decoder.decode(await vfs.read('src/a.txt'))).toBe('hello');
    expect(await vfs.list('src')).toEqual([
      expect.objectContaining({ path: 'src/a.txt', kind: 'file' }),
    ]);

    await vfs.rename('src/a.txt', 'src/b.txt');
    expect(await vfs.stat('src/a.txt')).toBeUndefined();
    expect(decoder.decode(await vfs.read('src/b.txt'))).toBe('hello');
    await vfs.copy('src/b.txt', 'src/c.txt');
    expect(decoder.decode(await vfs.read('src/c.txt'))).toBe('hello');
    expect(await vfs.remove('src', { recursive: true })).toBe(true);
    expect(await vfs.list('', { recursive: true })).toEqual([]);
  });

  it('rejects path traversal and stale-version writes', async () => {
    const { vfs } = create();
    await expect(vfs.write('../escape.txt', encoder.encode('x'))).rejects.toMatchObject({
      code: 'VFS_PATH_INVALID',
    });
    await vfs.write('value.txt', encoder.encode('one'));
    const results = await Promise.allSettled([
      vfs.write('value.txt', encoder.encode('two'), { expectedVersion: 1 }),
      vfs.write('value.txt', encoder.encode('three'), { expectedVersion: 1 }),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(decoder.decode(await vfs.read('value.txt'))).toMatch(/two|three/);
  });

  it('preserves binary data and emits change events', async () => {
    const { vfs } = create();
    const changes: string[] = [];
    const unwatch = vfs.watch?.((event) => changes.push(`${event.type}:${event.path}`));
    const data = new Uint8Array([0, 255, 1, 128]);
    await vfs.write('assets/data.bin', data);
    expect(await vfs.read('assets/data.bin')).toEqual(data);
    unwatch?.();
    expect(changes).toContain('created:assets/data.bin');
  });

  it('reopens persistent content when supported', async () => {
    const { vfs, reopen } = create();
    await vfs.write('persisted.txt', encoder.encode('saved'));
    if (!reopen) return;
    expect(decoder.decode(await reopen().read('persisted.txt'))).toBe('saved');
  });
});

describe('OverlayFS change export', () => {
  it('exports writes and deletions without mutating the base', async () => {
    const base = new MemoryFileSystem();
    await base.write('keep.txt', encoder.encode('base'));
    await base.write('remove.txt', encoder.encode('old'));
    const overlay = new OverlayFileSystem(base);
    await overlay.write('keep.txt', encoder.encode('changed'));
    await overlay.write('new.txt', encoder.encode('new'));
    await overlay.remove('remove.txt');

    const changes = await overlay.changes();
    expect(changes.written.map((item) => item.path).sort()).toEqual([
      'keep.txt',
      'new.txt',
    ]);
    expect(changes.deleted).toEqual(['remove.txt']);
    expect(decoder.decode(await base.read('keep.txt'))).toBe('base');
    expect(decoder.decode(await base.read('remove.txt'))).toBe('old');
  });
});

describe('normalizeVirtualPath', () => {
  it('normalizes separators and rejects parent traversal', () => {
    expect(normalizeVirtualPath('/src\\feature/./index.ts')).toBe(
      'src/feature/index.ts'
    );
    expect(() => normalizeVirtualPath('src/../../secret')).toThrow(
      'Path escapes virtual workspace'
    );
  });
});
