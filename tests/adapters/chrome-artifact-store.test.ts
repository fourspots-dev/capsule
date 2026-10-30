import { describe, expect, it } from 'vitest';
import { ChromeArtifactStore } from '../../src/adapters/chrome-artifact-store';

class Storage {
  values = new Map<string, unknown>();
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const selected = keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.map((key) => [key, this.values.get(key)]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

describe('ChromeArtifactStore', () => {
  it('persists bytes under isolated keys and supports filters', async () => {
    const storage = new Storage();
    let sequence = 0;
    const store = new ChromeArtifactStore(storage, {
      now: () => 10,
      newId: () => `artifact_${++sequence}`,
    });
    const ref = await store.put({
      name: 'page.txt',
      mimeType: 'text/plain',
      kind: 'text',
      data: new TextEncoder().encode('hello'),
      sessionId: 's',
      taskId: 't',
    });
    expect(new TextDecoder().decode(await store.read(ref.artifactId))).toBe('hello');
    expect(await store.list({ sessionId: 's', taskId: 't' })).toEqual([
      expect.objectContaining({ id: 'artifact_1', name: 'page.txt', bytes: 5 }),
    ]);
    expect(await store.remove('artifact_1')).toBe(true);
    expect(await store.read('artifact_1')).toBeUndefined();
  });

  it('cleans expired artifacts', async () => {
    let now = 10;
    const storage = new Storage();
    let sequence = 0;
    const store = new ChromeArtifactStore(storage, {
      now: () => now,
      newId: () => `artifact_${++sequence}`,
    });
    await store.put({ name: 'a', mimeType: 'text/plain', kind: 'text', data: new Uint8Array([1]) });
    now = 20;
    await store.put({ name: 'b', mimeType: 'text/plain', kind: 'text', data: new Uint8Array([2]) });
    expect(await store.cleanup(15)).toBe(1);
    expect((await store.list()).map((item) => item.name)).toEqual(['b']);
  });
});
