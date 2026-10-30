import { describe, expect, it, vi } from 'vitest';
import { createBrowserTools } from '../../src/adapters/browser-tools';
import type { BrowserProvider } from '../../src/core/browser-provider';
import { FakeApproval } from '../harness/fakes';
import { ToolExecutor } from '../../src/core';

function browser(): BrowserProvider {
  return {
    listTabs: vi.fn(async () => [
      { id: '1', title: 'Example', url: 'https://example.com', active: true },
      { id: '2', title: 'Docs', url: 'https://docs.example.com', active: false },
    ]),
    getTab: vi.fn(async () => ({ id: '1', title: 'Example', url: 'https://example.com', active: true })),
    createTab: vi.fn(async () => ({ id: '3', title: 'New', url: 'about:blank', active: true })),
    activateTab: vi.fn(async () => undefined),
    removeTab: vi.fn(async () => undefined),
    ensureTaskGroup: vi.fn(async (sessionId) => ({ sessionId, tabId: '1', ownedTabs: [] })),
    setWorkingTab: vi.fn(async () => undefined),
    getWorkingTab: vi.fn(async () => '1'),
    closeSessionTabs: vi.fn(async (sessionId) => ({
      sessionId,
      detachedTabs: [],
      closedTabs: [],
      errors: [],
    })),
    listFrames: vi.fn(async () => [
      { frameId: 'main', main: true, url: 'https://example.com' },
      {
        frameId: 'child',
        parentFrameId: 'main',
        main: false,
        url: 'https://docs.example.com/frame',
        name: 'docs',
      },
    ]),
    navigate: vi.fn(async (tabId, url) => ({ tabId, url, title: 'Example' })),
    snapshot: vi.fn(async (tabId) => ({
      tabId,
      title: 'Example',
      url: 'https://example.com',
      capturedAt: 1,
      truncated: false,
      text: 'button "Continue" @e1',
      nodes: [
        { ref: 'e1', role: 'button', name: 'Continue', depth: 0, interactive: true },
        { ref: 'e2', role: 'link', name: 'Docs', depth: 0, interactive: true },
      ],
    })),
    readText: vi.fn(async () => 'page text'),
    evaluate: vi.fn(async () => 'evaluated') as BrowserProvider['evaluate'],
    click: vi.fn(async () => undefined),
    mouseClick: vi.fn(async () => ({ x: 1, y: 2 })),
    hover: vi.fn(async () => ({ x: 1, y: 2 })),
    fill: vi.fn(async () => undefined),
    selectOption: vi.fn(async () => ({ selected: [] })),
    drag: vi.fn(async () => undefined),
    scroll: vi.fn(async () => ({ scrollY: 0, atTop: true, atBottom: false, found: false })),
    upload: vi.fn(async () => 1),
    waitFor: vi.fn(async () => true),
    screenshot: vi.fn(async () => ({ dataUrl: 'data:image/png;base64,x', format: 'png' as const })),
    printToPdf: vi.fn(async () => ({ dataBase64: 'cGRm', bytes: 3 })),
    dialog: vi.fn(async () => ({ open: false })),
    network: vi.fn(async () => ({ entries: [] })),
    cdp: vi.fn(async () => ({ ok: true })) as BrowserProvider['cdp'],
  };
}

describe('browser tool adapter', () => {
  it('exposes browser capabilities through the generic tool registry contract', () => {
    const tools = createBrowserTools(browser());
    expect(tools.map((item) => item.name)).toEqual(
      expect.arrayContaining(['list_tabs', 'navigate', 'snapshot', 'click', 'fill', 'read_page'])
    );
    expect(tools.every((item) => item.capabilities?.length)).toBe(true);
    expect(tools.find((item) => item.name === 'evaluate')).toMatchObject({
      risk: 'dangerous',
      effect: 'execute',
      replay: 'never',
    });
  });

  it('resolves the session working tab and keeps result contracts model-visible', async () => {
    const provider = browser();
    const tools = createBrowserTools(provider);
    const executor = new ToolExecutor(tools, new FakeApproval(true));
    const result = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: { id: 'call_1', name: 'read_page', arguments: '{}' },
    });
    expect(result).toEqual({
      callId: 'call_1',
      name: 'read_page',
      status: 'succeeded',
      output: { tabId: '1', text: 'page text' },
    });
    expect(provider.getWorkingTab).toHaveBeenCalledWith('session_1');
  });

  it('filters accessibility nodes without introducing a separate UI adapter', async () => {
    const executor = new ToolExecutor(createBrowserTools(browser()), new FakeApproval(true));
    const result = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: { id: 'call_1', name: 'find', arguments: '{"query":"docs"}' },
    });
    expect(result.output).toEqual([
      { ref: 'e2', role: 'link', name: 'Docs', depth: 0, interactive: true },
    ]);
  });

  it('exposes frame discovery and forwards frameId to snapshot, evaluate and actions', async () => {
    const provider = browser();
    const executor = new ToolExecutor(createBrowserTools(provider), new FakeApproval(true));
    const invoke = (name: string, args: string) =>
      executor.execute({
        sessionId: 'session_1',
        taskId: 'task_1',
        signal: new AbortController().signal,
        call: { id: `call_${name}`, name, arguments: args },
      });

    const frames = await invoke('list_frames', '{}');
    expect(frames.output).toEqual([
      expect.objectContaining({ frameId: 'main', main: true }),
      expect.objectContaining({ frameId: 'child', parentFrameId: 'main' }),
    ]);
    await invoke('snapshot', '{"frameId":"child"}');
    expect(provider.snapshot).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ frameId: 'child' })
    );
    await invoke('evaluate', '{"frameId":"child","code":"document.title"}');
    expect(provider.evaluate).toHaveBeenCalledWith(
      '1',
      'document.title',
      expect.objectContaining({ frameId: 'child' })
    );
    await invoke('read_page', '{"frameId":"child"}');
    expect(provider.readText).toHaveBeenCalledWith(
      '1',
      30_000,
      expect.objectContaining({ frameId: 'child' })
    );
    await invoke('wait', '{"frameId":"child","text":"ready"}');
    expect(provider.waitFor).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({ text: 'ready' }),
      expect.any(AbortSignal),
      { frameId: 'child' }
    );
    await invoke('click', '{"frameId":"child","ref":"@e1"}');
    expect(provider.click).toHaveBeenCalledWith('1', {
      frameId: 'child',
      ref: '@e1',
    });
  });
});
