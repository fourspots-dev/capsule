import { describe, expect, it, vi } from 'vitest';
import {
  ChromeBrowserProvider,
  type ChromeDebuggerApi,
  type ChromeTabsApi,
} from '../../src/adapters/chrome-browser';

function tab(id: number, url = 'https://example.com', active = true): chrome.tabs.Tab {
  return {
    id,
    url,
    title: `Tab ${id}`,
    active,
    windowId: 1,
    index: 0,
    pinned: false,
    highlighted: active,
    incognito: false,
    selected: active,
    discarded: false,
    autoDiscardable: true,
    frozen: false,
    lastAccessed: 1,
    groupId: -1,
  };
}

function fakeTabs(initial: chrome.tabs.Tab[]): ChromeTabsApi & { values: chrome.tabs.Tab[] } {
  const values = [...initial];
  return {
    values,
    query: vi.fn(async () => values),
    get: vi.fn(async (id: number) => {
      const found = values.find((item) => item.id === id);
      if (!found) throw new Error('No tab');
      return found;
    }),
    create: vi.fn(async (properties) => {
      const created = tab(99, properties.url, properties.active);
      values.push(created);
      return created;
    }),
    update: vi.fn(async (id, properties) => {
      const found = values.find((item) => item.id === id);
      if (!found) return undefined;
      if (properties.url) found.url = properties.url;
      if (properties.active !== undefined) found.active = properties.active;
      return found;
    }),
    remove: vi.fn(async (ids) => {
      const remove = new Set((Array.isArray(ids) ? ids : [ids]).map(Number));
      for (let index = values.length - 1; index >= 0; index -= 1) {
        if (remove.has(Number(values[index].id))) values.splice(index, 1);
      }
    }),
  };
}

function fakeDebugger(
  evaluate: (expression: string, params?: Record<string, unknown>) => unknown = (expression) =>
    expression.includes('document.title')
      ? { title: 'Example', url: 'https://example.com' }
      : true
) {
  const listeners: Array<
    (source: chrome.debugger.Debuggee, method: string, params?: object) => void
  > = [];
  const sendCommand = vi.fn(async (_target: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (method === 'Page.getFrameTree') {
      return {
        frameTree: {
          frame: {
            id: 'main',
            url: 'https://example.com',
            securityOrigin: 'https://example.com',
          },
          childFrames: [
            {
              frame: {
                id: 'child',
                parentId: 'main',
                url: 'https://docs.example.com/frame',
                name: 'docs',
                securityOrigin: 'https://docs.example.com',
              },
            },
          ],
        },
      };
    }
    if (method === 'Accessibility.getFullAXTree') {
      if ((params as any)?.frameId === 'child') {
        return {
          nodes: [
            {
              nodeId: 'c1',
              role: { value: 'RootWebArea' },
              name: { value: 'Child frame' },
              childIds: ['c2'],
            },
            {
              nodeId: 'c2',
              role: { value: 'button' },
              name: { value: 'Inside frame' },
              backendDOMNodeId: 33,
            },
          ],
        };
      }
      return {
        nodes: [
          {
            nodeId: '1',
            role: { value: 'RootWebArea' },
            name: { value: 'Example' },
            childIds: ['2', '3'],
          },
          {
            nodeId: '2',
            role: { value: 'button' },
            name: { value: 'Continue' },
            backendDOMNodeId: 22,
          },
          {
            nodeId: '3',
            role: { value: 'StaticText' },
            name: { value: 'Visible text' },
          },
        ],
      };
    }
    if (method === 'Page.createIsolatedWorld') return { executionContextId: 42 };
    if (method === 'Runtime.evaluate') {
      const expression = String((params as any)?.expression);
      if (expression.startsWith('document.querySelector(')) {
        return { result: { objectId: 'object_selector' } };
      }
      return { result: { value: evaluate(expression, params as Record<string, unknown>) } };
    }
    if (method === 'DOM.resolveNode') return { object: { objectId: 'object_22' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: true } };
    if (method === 'Page.captureScreenshot') return { data: 'cG5n' };
    return {};
  });
  const api: ChromeDebuggerApi & {
    emit(source: chrome.debugger.Debuggee, method: string, params?: object): void;
  } = {
    attach: vi.fn(async () => undefined),
    detach: vi.fn(async () => undefined),
    sendCommand,
    onEvent: {
      addListener: vi.fn((listener) => listeners.push(listener)),
      removeListener: vi.fn((listener) => {
        const index = listeners.indexOf(listener);
        if (index >= 0) listeners.splice(index, 1);
      }),
    },
    emit(source, method, params) {
      for (const listener of listeners) listener(source, method, params);
    },
  };
  return api;
}

describe('ChromeBrowserProvider', () => {
  it('binds a working tab and returns a compact accessibility snapshot with refs', async () => {
    const browser = new ChromeBrowserProvider({
      tabs: fakeTabs([tab(1)]),
      debugger: fakeDebugger(),
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    const group = await browser.ensureTaskGroup('session_1');
    expect(group).toMatchObject({ sessionId: 'session_1', tabId: '1', ownedTabs: [] });

    const snapshot = await browser.snapshot('1');
    expect(snapshot).toMatchObject({
      tabId: '1',
      title: 'Example',
      url: 'https://example.com',
      truncated: false,
    });
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({ role: 'RootWebArea', name: 'Example' }),
      expect.objectContaining({ role: 'button', name: 'Continue', ref: 'e1', interactive: true }),
      expect.objectContaining({ role: 'StaticText', name: 'Visible text' }),
    ]);
    expect(snapshot.text).toContain('button "Continue" @e1');
  });

  it('attaches once for multiple CDP calls and resolves snapshot refs for actions', async () => {
    const debuggerApi = fakeDebugger();
    const browser = new ChromeBrowserProvider({
      tabs: fakeTabs([tab(1)]),
      debugger: debuggerApi,
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    await browser.ensureTaskGroup('session_1');
    await browser.snapshot('1');
    await browser.click('1', { ref: '@e1' });
    await browser.fill('1', { selector: '#name' }, 'tinyai');

    expect(debuggerApi.attach).toHaveBeenCalledTimes(1);
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'DOM.resolveNode',
      { backendNodeId: 22 }
    );
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.callFunctionOn',
      expect.objectContaining({ objectId: 'object_22' })
    );
  });

  it('lists frames and scopes snapshots, refs, selectors and evaluation to a frame context', async () => {
    const debuggerApi = fakeDebugger((expression, params) =>
      expression.includes('document.title')
        ? {
            title: params?.contextId === 42 ? 'Child frame' : 'Example',
            url:
              params?.contextId === 42
                ? 'https://docs.example.com/frame'
                : 'https://example.com',
          }
        : true
    );
    const browser = new ChromeBrowserProvider({
      tabs: fakeTabs([tab(1)]),
      debugger: debuggerApi,
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    await browser.ensureTaskGroup('session_1');
    const frames = await browser.listFrames('1');
    expect(frames).toEqual([
      expect.objectContaining({ frameId: 'main', main: true }),
      expect.objectContaining({
        frameId: 'child',
        parentFrameId: 'main',
        name: 'docs',
        main: false,
      }),
    ]);

    const snapshot = await browser.snapshot('1', { frameId: 'child' });
    expect(snapshot).toMatchObject({
      frameId: 'child',
      url: 'https://docs.example.com/frame',
    });
    expect(snapshot.nodes).toEqual([
      expect.objectContaining({ role: 'RootWebArea', name: 'Child frame' }),
      expect.objectContaining({ role: 'button', name: 'Inside frame', ref: 'e1' }),
    ]);

    await browser.click('1', { frameId: 'child', ref: '@e1' });
    await browser.fill('1', { frameId: 'child', selector: '#name' }, 'value');
    await browser.evaluate('1', 'document.title', { frameId: 'child' });
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'DOM.resolveNode',
      { backendNodeId: 33 }
    );
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Runtime.evaluate',
      expect.objectContaining({ contextId: 42, expression: 'document.querySelector("#name")' })
    );
    expect(debuggerApi.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.createIsolatedWorld',
      expect.objectContaining({ frameId: 'child' })
    );
  });

  it('blocks non-dialog commands while a page dialog is open', async () => {
    const debuggerApi = fakeDebugger();
    const browser = new ChromeBrowserProvider({
      tabs: fakeTabs([tab(1)]),
      debugger: debuggerApi,
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    await browser.ensureTaskGroup('session_1');
    debuggerApi.emit({ tabId: 1 }, 'Page.javascriptDialogOpening', { message: 'hello' });
    await expect(browser.evaluate('1', '1 + 1')).rejects.toMatchObject({
      code: 'BROWSER_DIALOG_OPEN',
    });
    debuggerApi.emit({ tabId: 1 }, 'Page.javascriptDialogClosed', {});
    await expect(browser.evaluate('1', '1 + 1')).resolves.toBe(true);
  });

  it('creates and owns a tab when no inspectable tab exists, then closes and detaches it', async () => {
    const tabs = fakeTabs([]);
    const debuggerApi = fakeDebugger();
    const browser = new ChromeBrowserProvider({
      tabs,
      debugger: debuggerApi,
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    const group = await browser.ensureTaskGroup('session_1');
    expect(group).toMatchObject({ tabId: '99', ownedTabs: ['99'] });
    await browser.snapshot('99');
    const report = await browser.closeSessionTabs('session_1');
    expect(report).toMatchObject({
      detachedTabs: ['99'],
      closedTabs: ['99'],
      errors: [],
    });
    expect(tabs.remove).toHaveBeenCalledWith(99);
    expect(debuggerApi.detach).toHaveBeenCalledWith({ tabId: 99 });
  });

  it('captures screenshots and validates navigation URLs', async () => {
    const tabs = fakeTabs([tab(1)]);
    const browser = new ChromeBrowserProvider({
      tabs,
      debugger: fakeDebugger(),
      clock: { now: () => 10, setTimeout: (callback) => callback() },
    });
    await browser.ensureTaskGroup('session_1');
    const captured = await browser.screenshot('1');
    expect(captured).toEqual({ dataUrl: 'data:image/png;base64,cG5n', format: 'png' });
    const info = await browser.navigate('1', 'example.org');
    expect(tabs.update).toHaveBeenCalledWith(1, { url: 'https://example.org' });
    expect(info.url).toBe('https://example.com');
  });

  it('removes debugger listeners on dispose', () => {
    const debuggerApi = fakeDebugger();
    const browser = new ChromeBrowserProvider({
      tabs: fakeTabs([tab(1)]),
      debugger: debuggerApi,
    });
    browser.dispose();
    expect(debuggerApi.onEvent.removeListener).toHaveBeenCalledTimes(1);
  });
});
