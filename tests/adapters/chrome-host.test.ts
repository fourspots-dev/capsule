import { describe, expect, it } from 'vitest';
import { ChromeHostBridge, type ChromeStorageArea } from '../../src/adapters/chrome-host';
import { inspectHostCapabilities } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';

class Storage implements ChromeStorageArea {
  values = new Map<string, unknown>();
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const selected =
      keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      selected.map((key) => [key, structuredClone(this.values.get(key))])
    );
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

describe('ChromeHostBridge', () => {
  it('persists a virtual workspace through chrome.storage semantics', async () => {
    const storage = new Storage();
    const host = new ChromeHostBridge({ storage });
    expect(inspectHostCapabilities(host).healthy).toBe(true);
    const first = new VirtualWorkspace({
      host,
      storageKey: 'chrome:workspace',
    });
    await first.fs.write('src/page.ts', new TextEncoder().encode('export const page = true;\n'));
    await first.checkpoint('chrome-base');

    const second = new VirtualWorkspace({
      host,
      storageKey: 'chrome:workspace',
    });
    expect(
      new TextDecoder().decode(await second.fs.read('src/page.ts'))
    ).toBe('export const page = true;\n');
    expect((await second.status()).head).toBeDefined();
  });
});
