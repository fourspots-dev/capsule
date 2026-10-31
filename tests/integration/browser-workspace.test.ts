import { describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../../src/core';
import type { BrowserProvider } from '../../src/adapters/browser-provider';
import { FakeApproval, FakeClock, events, text } from '../harness/fakes';
import { SequentialIdGenerator } from '../../src/core';
import { InMemorySessionStore } from '../../src/core';
import { createBrowserWorkspace } from '../../src/adapters/browser-workspace-factory';
import { command } from '../harness/workspace';

function browser(): BrowserProvider & { dispose: ReturnType<typeof vi.fn> } {
  return {
    listTabs: vi.fn(async () => []),
    getTab: vi.fn(async () => null),
    createTab: vi.fn(async () => ({ id: '1', active: true, url: 'about:blank' })),
    activateTab: vi.fn(async () => undefined),
    removeTab: vi.fn(async () => undefined),
    ensureTaskGroup: vi.fn(async (sessionId) => ({ sessionId, tabId: '1', ownedTabs: [] })),
    setWorkingTab: vi.fn(async () => undefined),
    getWorkingTab: vi.fn(async () => '1'),
    closeSessionTabs: vi.fn(async (sessionId) => ({
      sessionId,
      detachedTabs: ['1'],
      closedTabs: [],
      errors: [],
    })),
    navigate: vi.fn(async (tabId, url) => ({ tabId, title: 'Example', url })),
    snapshot: vi.fn(async (tabId) => ({
      tabId,
      title: 'Example',
      url: 'https://example.com',
      text: '',
      nodes: [],
      truncated: false,
      capturedAt: 1,
    })),
    readText: vi.fn(async () => 'text'),
    evaluate: vi.fn(async () => null) as BrowserProvider['evaluate'],
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
    cdp: vi.fn(async () => null) as BrowserProvider['cdp'],
    dispose: vi.fn(),
  };
}

describe('createBrowserWorkspace', () => {
  it('wires browser tools, persistence and session resource lifecycle from one factory', async () => {
    const browserProvider = browser();
    const bundle = createBrowserWorkspace({
      browser: browserProvider,
      model: {
        async *stream() {
          yield* events(...text('done'));
        },
      },
      sessionStore: new InMemorySessionStore(),
      approval: new FakeApproval(true),
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
    });

    const ack = await bundle.runtime.command(command('session_1', 'command_1', 'hello'));
    expect(ack.status).toBe('accepted');
    await bundle.runtime.waitForSessionIdle('session_1');
    await bundle.runtime.restart('session_1');
    expect(browserProvider.closeSessionTabs).toHaveBeenCalledTimes(1);

    await bundle.dispose();
    expect(browserProvider.closeSessionTabs).toHaveBeenCalledTimes(2);
    expect(browserProvider.dispose).toHaveBeenCalledTimes(1);
  });

  it('applies tool capability selection and extra registrations', async () => {
    const extra: ToolDefinition = {
      name: 'custom',
      description: 'custom',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      capabilities: ['custom:read'],
      execute: async () => 'ok',
    };
    const bundle = createBrowserWorkspace({
      browser: browser(),
      model: {
        async *stream() {
          yield* events(...text('done'));
        },
      },
      sessionStore: new InMemorySessionStore(),
      approval: new FakeApproval(true),
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
      toolSelection: { capabilities: ['custom:read'] },
      additionalTools: [{ definition: extra, source: 'plugin', sourceId: 'test' }],
    });
    expect(bundle.tools.descriptors().map((tool) => tool.name)).toEqual(['custom']);
    await bundle.dispose();
  });
});
