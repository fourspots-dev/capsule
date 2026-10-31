import { describe, expect, it, vi } from 'vitest';
import { ChromeRuntimeExtension } from '../../src/adapters/chrome-runtime-extension';

function setup() {
  const removed: Array<(tabId: number, info: chrome.tabs.OnRemovedInfo) => void> = [];
  const updated: Array<(tabId: number, info: chrome.tabs.OnUpdatedInfo) => void> = [];
  const tabs = {
    forget: vi.fn(async () => undefined),
    reconcile: vi.fn(async () => undefined),
    resolve: vi.fn(async () => ({
      sessionId: 'session_1',
      scope: 'tab' as const,
      windowId: 1,
      activeTabId: '10',
      memberTabIds: ['10'],
      updatedAt: 1,
    })),
    create: vi.fn(async () => ({
      sessionId: 'session_2',
      scope: 'tab' as const,
      windowId: 1,
      activeTabId: '11',
      memberTabIds: ['11'],
      updatedAt: 1,
    })),
    bind: vi.fn(async () => ({
      sessionId: 'session_bound',
      scope: 'tab' as const,
      windowId: 1,
      activeTabId: '10',
      memberTabIds: ['10'],
      updatedAt: 1,
    })),
    releaseSession: vi.fn(async () => undefined),
    clear: vi.fn(async () => undefined),
  };
  const runtime = {
    loadProjection: vi.fn(async (sessionId: string) => ({
      sessionId,
      rows: [],
    })),
  };
  const browser = {
    listTabs: vi.fn(async () => [{ id: '10', active: true }]),
    setWorkingTab: vi.fn(async () => undefined),
  };
  const chromeApi = {
    tabs: {
      get: vi.fn(async () => ({ windowId: 1, groupId: 5 })),
      onRemoved: {
        addListener: vi.fn((listener) => removed.push(listener)),
        removeListener: vi.fn(),
      },
      onUpdated: {
        addListener: vi.fn((listener) => updated.push(listener)),
        removeListener: vi.fn(),
      },
    },
  };
  const extension = new ChromeRuntimeExtension(
    runtime as never,
    tabs as never,
    browser as never,
    chromeApi as never
  );
  return { extension, tabs, runtime, browser, chromeApi, removed, updated };
}

describe('ChromeRuntimeExtension', () => {
  it('reconciles group updates and forgets closed tabs', async () => {
    const h = setup();
    h.updated[0](10, { groupId: 5 });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.tabs.reconcile).toHaveBeenCalledWith({
      windowId: 1,
      tabId: '10',
      groupId: 5,
    });

    h.removed[0](10, {
      windowId: 1,
      isWindowClosing: false,
    });
    expect(h.tabs.forget).toHaveBeenCalledWith({
      windowId: 1,
      tabId: '10',
    });
    h.extension.dispose();
    expect(h.chromeApi.tabs.onUpdated.removeListener).toHaveBeenCalledTimes(1);
    expect(h.chromeApi.tabs.onRemoved.removeListener).toHaveBeenCalledTimes(1);
  });

  it('routes browser requests and lifecycle hooks through the extension', async () => {
    const h = setup();
    await expect(
      h.extension.tryHandle({ type: 'list_tabs' })
    ).resolves.toMatchObject({
      handled: true,
      data: [expect.objectContaining({ id: '10' })],
    });
    await expect(
      h.extension.tryHandle({
        type: 'select_tab',
        sessionId: 'session_1',
        tabId: '10',
      })
    ).resolves.toEqual({ handled: true, data: true });
    await expect(
      h.extension.tryHandle({
        type: 'resolve_tab_session',
        windowId: 1,
        tabId: '10',
      })
    ).resolves.toMatchObject({
      handled: true,
      data: {
        sessionId: 'session_1',
        projection: { sessionId: 'session_1' },
      },
    });
    await expect(
      h.extension.tryHandle({
        type: 'create_tab_session',
        windowId: 1,
        tabId: '11',
      })
    ).resolves.toMatchObject({ handled: true, data: { sessionId: 'session_2' } });
    await expect(
      h.extension.tryHandle({
        type: 'bind_tab_session',
        windowId: 1,
        tabId: '10',
        sessionId: 'session_bound',
      })
    ).resolves.toMatchObject({
      handled: true,
      data: { sessionId: 'session_bound' },
    });
    await h.extension.beforeDeleteSession?.('session_1');
    await h.extension.beforeClearHistory?.();
    expect(h.tabs.releaseSession).toHaveBeenCalledWith('session_1');
    expect(h.tabs.clear).toHaveBeenCalled();
    await expect(
      h.extension.tryHandle({ type: 'unknown_extension_request' })
    ).resolves.toEqual({ handled: false });
  });
});
