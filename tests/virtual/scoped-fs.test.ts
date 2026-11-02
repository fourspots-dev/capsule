import { describe, expect, it } from 'vitest';
import { MemoryFileSystem, ScopedFileSystem } from '../../src/virtual';

describe('REQ-WORKSPACE-003 scoped virtual file system', () => {
  it('isolates identical paths in different workspaces', async () => {
    const root = new MemoryFileSystem();
    const first = new ScopedFileSystem(root, '.tinyai/workspaces/ws_a');
    const second = new ScopedFileSystem(root, '.tinyai/workspaces/ws_b');
    await first.write('app/index.html', new TextEncoder().encode('A'));
    await second.write('app/index.html', new TextEncoder().encode('B'));
    expect(new TextDecoder().decode(await first.read('app/index.html'))).toBe(
      'A'
    );
    expect(new TextDecoder().decode(await second.read('app/index.html'))).toBe(
      'B'
    );
    expect((await first.list('', { recursive: true })).map((item) => item.path))
      .toEqual(['app', 'app/index.html']);
  });

  it('translates copy, rename, remove and list results', async () => {
    const root = new MemoryFileSystem();
    const scoped = new ScopedFileSystem(root, '.tinyai/workspaces/ws_a');
    await scoped.write('one.txt', new TextEncoder().encode('one'));
    await scoped.copy('one.txt', 'two.txt');
    await scoped.rename('two.txt', 'three.txt');
    expect((await scoped.stat('three.txt'))?.path).toBe('three.txt');
    expect(await scoped.remove('one.txt')).toBe(true);
    expect((await scoped.list('', { recursive: true })).map((item) => item.path))
      .toEqual(['three.txt']);
    expect(
      (await root.list('', { recursive: true })).some(
        (item) => item.path === 'three.txt'
      )
    ).toBe(false);
  });
});
