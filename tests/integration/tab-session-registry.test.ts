import { describe, expect, it, vi } from 'vitest';
import type { BrowserProvider } from '../../src/core';
import { TabSessionRegistry, type TabSessionStorage } from '../../src/runtime/tab-session-registry';
import { events, text } from '../harness/fakes';
import { createTestWorkspace } from '../harness/workspace';

function memoryStorage(): TabSessionStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    async get(key) {
      return { [key]: values.get(key) };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    async remove(key) {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
    },
  };
}

function browser() {
  return {
    setWorkingTab: vi.fn(async () => undefined),
    releaseSession: vi.fn(async () => undefined),
  } as unknown as BrowserProvider;
}

describe('TabSessionRegistry', () => {
  it('keeps one conversation per window/tab and reuses it on reactivation', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs = browser();
    let sequence = 0;
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      createSessionId: () => `session_${++sequence}`,
    });

    const first = await registry.resolve({ windowId: 1, tabId: '10' });
    const same = await registry.resolve({ windowId: 1, tabId: '10' });
    const other = await registry.resolve({ windowId: 1, tabId: '11' });

    expect(first.sessionId).toBe('session_1');
    expect(same.sessionId).toBe('session_1');
    expect(other.sessionId).toBe('session_2');
    expect(tabs.setWorkingTab).toHaveBeenCalledWith('session_1', '10', {
      activate: false,
    });
    expect(tabs.setWorkingTab).toHaveBeenCalledWith('session_2', '11', {
      activate: false,
    });
  });

  it('replaces the current tab conversation and can bind history to another tab', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: browser(),
      createSessionId: (() => {
        let sequence = 0;
        return () => `session_${++sequence}`;
      })(),
    });
    const context = { windowId: 2, tabId: '20' };
    const first = await registry.resolve(context);
    const second = await registry.create(context);
    expect(second.sessionId).not.toBe(first.sessionId);

    await registry.bind({ windowId: 2, tabId: '21' }, first.sessionId);
    expect(await registry.list()).toEqual([
      expect.objectContaining({ tabId: '20', sessionId: second.sessionId }),
      expect.objectContaining({ tabId: '21', sessionId: first.sessionId }),
    ]);
    await registry.bind(context, first.sessionId);
    expect(await registry.list()).toEqual([
      expect.objectContaining({ tabId: '20', sessionId: first.sessionId }),
    ]);
  });

  it('persists bindings for runtime restarts and releases them when cleared', async () => {
    const storage = memoryStorage();
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs = browser();
    const first = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      storage,
      createSessionId: () => 'session_persisted',
    });
    await first.resolve({ windowId: 3, tabId: '30' });

    const second = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      storage,
      createSessionId: () => 'session_new',
    });
    expect(await second.resolve({ windowId: 3, tabId: '30' })).toMatchObject({
      sessionId: 'session_persisted',
    });
    await second.clear();
    expect(tabs.releaseSession).toHaveBeenCalledWith('session_persisted');
    expect(storage.values.has('tinyai:tab-sessions:v1')).toBe(false);
  });
});
