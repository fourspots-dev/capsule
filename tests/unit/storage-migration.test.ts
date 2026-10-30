import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../../src/core';
import type { ChromeKeyValueStorage } from '../../src/runtime/chrome-runtime';
import {
  CONFIG_KEY,
  MIGRATION_KEY,
  SKILLS_KEY,
  migrateLegacyStorage,
} from '../../src/runtime/storage-migration';

class Storage implements ChromeKeyValueStorage {
  readonly values = new Map<string, unknown>();
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

describe('legacy storage migration', () => {
  it('moves config, skills and sessions into canonical stores and removes old keys', async () => {
    const storage = new Storage();
    const sessions = new InMemorySessionStore();
    storage.values.set('clj-agent-config', {
      approval: 'auto',
      connection: 'default',
      connections: [{ id: 'default', 'base-url': 'https://api.example/v1', 'api-key': 'key' }],
    });
    storage.values.set('agent_skills', [
      { name: 'old', description: 'old', body: 'Old body' },
    ]);
    storage.values.set('clj-agent-skills', [
      { name: 'current', description: 'current', body: 'Current body' },
    ]);
    storage.values.set('clj-agent-sessions', {
      sessions: [
        {
          id: 'old-session',
          messages: [{ role: 'user', content: 'hello' }],
          timeline: [{ kind: 'user', text: 'hello' }],
        },
      ],
    });

    await expect(migrateLegacyStorage(storage, sessions, 10)).resolves.toEqual({
      migrated: true,
      importedSessions: 1,
    });
    expect(storage.values.get(CONFIG_KEY)).toMatchObject({ approval: 'auto' });
    expect(storage.values.get(SKILLS_KEY)).toEqual([
      expect.objectContaining({ name: 'old' }),
      expect.objectContaining({ name: 'current' }),
    ]);
    expect(storage.values.get(MIGRATION_KEY)).toBe(true);
    expect(await sessions.load('legacy_old-session')).toMatchObject({
      rows: [expect.objectContaining({ text: 'hello' })],
    });
    expect(storage.values.has('clj-agent-config')).toBe(false);
    expect(storage.values.has('clj-agent-sessions')).toBe(false);
    expect(storage.values.has('agent_skills')).toBe(false);
    expect(storage.values.has('clj-agent-skills')).toBe(false);

    await expect(migrateLegacyStorage(storage, sessions, 20)).resolves.toEqual({
      migrated: false,
      importedSessions: 0,
    });
  });
});
