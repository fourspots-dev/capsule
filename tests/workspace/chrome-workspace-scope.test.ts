import { describe, expect, it } from 'vitest';
import { ChromeHostBridge } from '../../src/adapters/chrome-host';
import { ChromeWorkspaceScopeRegistry } from '../../src/runtime/chrome-workspace-scope';
import { VirtualWorkspace } from '../../src/virtual';

describe('REQ-WORKSPACE-003 Chrome workspace scopes', () => {
  it('migrates the legacy global workspace once and then isolates scopes', async () => {
    const data: Record<string, unknown> = {};
    const host = new ChromeHostBridge({
      storage: {
        async get(keys) {
          if (keys === null) return { ...data };
          const selected = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            selected
              .filter((key) => key in data)
              .map((key) => [key, data[key]])
          );
        },
        async set(items) {
          Object.assign(data, items);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete data[key];
          }
        },
      },
      id: 'chrome-test',
    });
    const legacy = new VirtualWorkspace({
      host,
      storageKey: 'tinyai:virtual-workspace:v1',
    });
    await legacy.fs.write(
      'minesweeper.html',
      new TextEncoder().encode('<h1>legacy</h1>')
    );
    const registry = new ChromeWorkspaceScopeRegistry({
      host,
      legacyWorkspace: legacy,
    });
    const first = await registry.get('ws_first');
    const second = await registry.get('ws_second');
    expect(
      new TextDecoder().decode(await first.fs.read('minesweeper.html'))
    ).toBe('<h1>legacy</h1>');
    await expect(second.fs.read('minesweeper.html')).rejects.toMatchObject({
      code: 'VFS_NOT_FOUND',
    });
    await second.fs.write(
      'secret.txt',
      new TextEncoder().encode('second')
    );
    await expect(first.fs.read('secret.txt')).rejects.toMatchObject({
      code: 'VFS_NOT_FOUND',
    });
  });
});
