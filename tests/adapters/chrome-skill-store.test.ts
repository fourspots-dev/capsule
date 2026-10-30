import { describe, expect, it } from 'vitest';
import { ChromeSkillStore } from '../../src/adapters/chrome-skill-store';
import { ExtensionRegistry } from '../../src/core/extension-registry';
import { createSkillTools } from '../../src/adapters/skill-tools';
import { ToolExecutor } from '../../src/core';
import { FakeApproval } from '../harness/fakes';

class Storage {
  values = new Map<string, unknown>();
  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    const selected = keys === null ? [...this.values.keys()] : Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(selected.map((key) => [key, this.values.get(key)]));
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

describe('ChromeSkillStore', () => {
  it('reads the canonical skill store and persists model-created skills through tools', async () => {
    const storage = new Storage();
    storage.values.set('tinyai:v1:skills', [
      { name: 'existing', description: 'old', body: 'Existing $ARGUMENTS' },
    ]);
    const store = new ChromeSkillStore(storage);
    const registry = new ExtensionRegistry();
    registry.register({
      id: 'tinyai.skills',
      name: 'tinyai skills',
      version: '1',
      source: 'builtin',
      skills: await store.list(),
    });
    const executor = new ToolExecutor(createSkillTools(registry, store), new FakeApproval(true));
    const saved = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'c1',
        name: 'save_skill',
        arguments: '{"name":"new","description":"new skill","body":"Do it"}',
      },
    });
    expect(saved.status).toBe('succeeded');
    expect((await store.list()).map((skill) => skill.name).sort()).toEqual(['existing', 'new']);
    expect(registry.skill('new')).toMatchObject({ body: 'Do it' });
  });
});
