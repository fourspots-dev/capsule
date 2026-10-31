import { describe, expect, it } from 'vitest';
import { ChromeSessionStore, type ChromeStorageArea } from '../../src/adapters/chrome-session-store';
import type { SessionSnapshot } from '../../src/core';

class MemoryStorage implements ChromeStorageArea {
  readonly values = new Map<string, unknown>();
  readonly writes: Array<Record<string, unknown>> = [];
  readonly removals: Array<string | string[]> = [];

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const selected = keys === null
      ? [...this.values.keys()]
      : Array.isArray(keys)
        ? keys
        : [keys];
    return Object.fromEntries(selected.map((key) => [key, this.values.get(key)]));
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.writes.push(items);
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }

  async remove(keys: string | string[]): Promise<void> {
    this.removals.push(keys);
    for (const key of Array.isArray(keys) ? keys : [keys]) this.values.delete(key);
  }
}

function snapshot(sessionId: string, revision = 1): SessionSnapshot {
  return {
    schemaVersion: 1,
    sessionId,
    logEpoch: `epoch_${sessionId}`,
    revision,
    eventSeq: revision,
    taskStatus: 'completed',
    messages: [{ role: 'user', content: `message ${revision}` }],
    rows: [
      {
        id: `row_${sessionId}`,
        entityId: `input_${sessionId}`,
        productTurnId: `task_${sessionId}`,
        kind: 'user',
        text: `message ${revision}`,
        status: 'completed',
      },
    ],
    ledger: [
      {
        inputId: `input_${sessionId}`,
        sourceCommandId: `command_${sessionId}`,
        status: 'promoted',
        delivery: 'startNow',
        text: `message ${revision}`,
        admittedAt: revision,
      },
    ],
    events: [],
    commands: [],
  };
}

describe('ChromeSessionStore', () => {
  it('stores each session under an isolated namespaced key and returns defensive copies', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeSessionStore({ storage, keyPrefix: 'test:v1:' });
    const first = snapshot('session/a', 2);
    await store.save(first);
    await store.save(snapshot('session_b', 3));
    first.rows[0].text = 'mutated after save';

    expect(storage.writes).toHaveLength(2);
    expect(storage.writes.map((write) => Object.keys(write))).toEqual([
      ['test:v1:session%2Fa'],
      ['test:v1:session_b'],
    ]);
    const loaded = await store.load('session/a');
    expect(loaded?.rows[0].text).toBe('message 2');
    loaded!.rows[0].text = 'mutated after load';
    expect((await store.load('session/a'))?.rows[0].text).toBe('message 2');
  });

  it('returns undefined for missing sessions and removes only the requested key', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeSessionStore({ storage });
    expect(await store.load('missing')).toBeUndefined();
    await store.save(snapshot('session_a'));
    await store.save(snapshot('session_b'));
    await store.remove('session_a');

    expect(await store.load('session_a')).toBeUndefined();
    expect((await store.load('session_b'))?.sessionId).toBe('session_b');
    expect(storage.removals).toEqual([store.storageKey('session_a')]);
  });

  it('clears only session snapshots while preserving unrelated extension storage', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeSessionStore({ storage });
    await store.save(snapshot('session_a'));
    await store.save(snapshot('session_b'));
    storage.values.set('tinyai:v2:config', { approval: 'ask' });

    await store.clear();

    expect(await store.list()).toEqual([]);
    expect(storage.values.get('tinyai:v2:config')).toEqual({ approval: 'ask' });
  });

  it('serializes overlapping writes in invocation order and makes later reads observe them', async () => {
    const storage = new MemoryStorage();
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const originalSet = storage.set.bind(storage);
    let calls = 0;
    storage.set = async (items) => {
      calls += 1;
      if (calls === 1) await gate;
      await originalSet(items);
    };
    const store = new ChromeSessionStore({ storage });

    const first = store.save(snapshot('session_1', 1));
    const second = store.save(snapshot('session_1', 2));
    const read = store.load('session_1');
    while (calls === 0) await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();

    await Promise.all([first, second]);
    expect((await read)?.revision).toBe(2);
    expect(storage.writes.map((write) => {
      const value = Object.values(write)[0] as SessionSnapshot;
      return value.revision;
    })).toEqual([1, 2]);
  });

  it('rejects unsupported schemas with an explicit stable error', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeSessionStore({ storage });
    storage.values.set(store.storageKey('old_session'), {
      ...snapshot('old_session'),
      schemaVersion: 0,
    });

    await expect(store.load('old_session')).rejects.toMatchObject({
      code: 'STORAGE_SCHEMA_UNSUPPORTED',
    });
  });

  it('rejects corrupt objects and session-id mismatches', async () => {
    const storage = new MemoryStorage();
    const store = new ChromeSessionStore({ storage });
    storage.values.set(store.storageKey('session_1'), 'not a snapshot');
    await expect(store.load('session_1')).rejects.toMatchObject({
      code: 'STORAGE_SNAPSHOT_INVALID',
    });

    storage.values.set(store.storageKey('session_2'), snapshot('other_session'));
    await expect(store.load('session_2')).rejects.toMatchObject({
      code: 'STORAGE_SNAPSHOT_INVALID',
    });
  });

  it('continues a key queue after one failed write while surfacing that failure', async () => {
    const storage = new MemoryStorage();
    const originalSet = storage.set.bind(storage);
    let calls = 0;
    storage.set = async (items) => {
      calls += 1;
      if (calls === 1) throw new Error('quota exceeded');
      await originalSet(items);
    };
    const store = new ChromeSessionStore({ storage });

    await expect(store.save(snapshot('session_1', 1))).rejects.toThrow('quota exceeded');
    await expect(store.save(snapshot('session_1', 2))).resolves.toBeUndefined();
    expect((await store.load('session_1'))?.revision).toBe(2);
  });

  it('requires an explicit storage area outside a Chrome runtime', () => {
    expect(() => new ChromeSessionStore()).toThrowError(/chrome\.storage\.local is unavailable/);
  });
});
