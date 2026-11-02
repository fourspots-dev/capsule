import { describe, expect, it, vi } from 'vitest';
import type { BrowserProvider } from '../../src/adapters/browser-provider';
import { TabSessionRegistry, type TabSessionStorage } from '../../src/adapters/chrome-workspace-session-registry';
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

function browser(
  tabs: Array<{ id: string; active: boolean; windowId?: number; groupId?: number }> = []
) {
  return {
    listTabs: vi.fn(async () => tabs),
    getTab: vi.fn(async (tabId: string) =>
      tabs.find((tab) => tab.id === tabId) ?? {
        id: tabId,
        active: false,
      }
    ),
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

  it('shares one conversation across members of the same tab group', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs = browser([
      { id: '10', active: true, windowId: 1, groupId: 5 },
      { id: '11', active: false, windowId: 1, groupId: 5 },
    ]);
    let sequence = 0;
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      createSessionId: () => `session_${++sequence}`,
    });

    const first = await registry.resolve({
      windowId: 1,
      tabId: '10',
      groupId: 5,
    });
    const second = await registry.resolve({
      windowId: 1,
      tabId: '11',
      groupId: 5,
    });

    expect(first.sessionId).toBe('session_1');
    expect(second).toMatchObject({
      sessionId: 'session_1',
      scope: 'group',
      groupId: 5,
      activeTabId: '11',
      executionTabId: '10',
      memberTabIds: ['10', '11'],
    });
    expect(tabs.setWorkingTab).not.toHaveBeenCalledWith(
      'session_1',
      '11',
      expect.anything()
    );
    expect(sequence).toBe(1);

    await registry.selectExecutionTab('session_1', '11');
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        sessionId: 'session_1',
        activeTabId: '11',
        executionTabId: '11',
      }),
    ]);
    expect(tabs.setWorkingTab).toHaveBeenCalledWith('session_1', '11', {
      activate: true,
    });
  });

  it('promotes the active standalone conversation when its tab is grouped', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs = browser([
      { id: '12', active: true, windowId: 1, groupId: 6 },
      { id: '13', active: false, windowId: 1, groupId: 6 },
    ]);
    let sequence = 0;
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      createSessionId: () => `session_${++sequence}`,
    });
    const standalone = await registry.resolve({ windowId: 1, tabId: '12' });

    const grouped = await registry.resolve({
      windowId: 1,
      tabId: '12',
      groupId: 6,
    });

    expect(grouped).toMatchObject({
      sessionId: standalone.sessionId,
      scope: 'group',
      groupId: 6,
    });
    expect(sequence).toBe(1);
    expect(await registry.list()).toHaveLength(1);
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
      expect.objectContaining({ activeTabId: '20', sessionId: second.sessionId }),
      expect.objectContaining({ activeTabId: '21', sessionId: first.sessionId }),
    ]);
    await registry.bind(context, first.sessionId);
    expect(await registry.list()).toEqual([
      expect.objectContaining({ activeTabId: '20', sessionId: first.sessionId }),
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

  it('drops a standalone binding when its tab disappears before activation', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs = browser([{ id: '50', active: true, windowId: 5 }]);
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: tabs,
      createSessionId: () => 'session_stale',
    });
    await registry.resolve({ windowId: 5, tabId: '50' });
    vi.mocked(tabs.getTab).mockResolvedValue(null);

    await expect(
      registry.resolve({ windowId: 5, tabId: '50' })
    ).rejects.toMatchObject({ code: 'BROWSER_TAB_NOT_FOUND' });
    expect(await registry.list()).toEqual([]);
  });

  it('promotes a standalone session when the agent opens another workspace tab', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const tabs: Array<{
      id: string;
      active: boolean;
      windowId?: number;
      groupId?: number;
    }> = [{ id: '40', active: true, windowId: 4 }];
    const browserProvider = {
      ...browser(tabs),
      createTab: vi.fn(async () => {
        tabs.push({ id: '41', active: false, windowId: 4, groupId: 8 });
        return { id: '41', active: false, windowId: 4, groupId: 8 };
      }),
      addTabToSession: vi.fn(async (sessionId: string) => ({
        sessionId,
        tabId: '41',
        groupId: 8,
        ownedTabs: ['41'],
      })),
      listSessionTabs: vi.fn(async () => tabs),
      assertSessionTab: vi.fn(async () => undefined),
    } as unknown as BrowserProvider;
    const registry = new TabSessionRegistry({
      runtime: workspace.runtime,
      browser: browserProvider,
      createSessionId: () => 'session_group',
    });
    await registry.resolve({ windowId: 4, tabId: '40' });

    const created = await registry.createTab('session_group', 'https://example.com');
    expect(created).toMatchObject({ id: '41', groupId: 8 });
    expect(browserProvider.addTabToSession).toHaveBeenCalledWith(
      'session_group',
      '41',
      { owned: true, baseTabId: '40' }
    );
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        scope: 'group',
        groupId: 8,
        memberTabIds: ['40', '41'],
        sessionId: 'session_group',
      }),
    ]);
    await registry.switchTab('session_group', '40');
    expect(browserProvider.setWorkingTab).toHaveBeenCalledWith(
      'session_group',
      '40',
      { activate: true }
    );
    expect(await registry.list()).toEqual([
      expect.objectContaining({
        sessionId: 'session_group',
        activeTabId: '40',
        executionTabId: '40',
      }),
    ]);
  });
});
