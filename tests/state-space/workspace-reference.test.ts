import assert from 'node:assert/strict';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type {
  BrowserProvider,
  TabDescriptor,
} from '../../src/adapters/browser-provider';
import {
  TabSessionRegistry,
  type TabSessionStorage,
} from '../../src/adapters/chrome-workspace-session-registry';
import { events, text } from '../harness/fakes';
import { createTestWorkspace } from '../harness/workspace';

type Event =
  | { type: 'activate'; tab: string }
  | { type: 'close'; tab: string }
  | { type: 'group'; tab: string; group: number }
  | { type: 'ungroup'; tab: string }
  | { type: 'reload' };

interface ReferenceTab {
  id: string;
  groupId?: number;
}

interface ReferenceGroupBinding {
  sessionId: string;
  activeTabId: string;
  memberTabIds: string[];
}

interface ReferenceState {
  tabs: ReferenceTab[];
  activeTabId?: string;
  nextSession: number;
  tabBindings: Map<string, string>;
  groupBindings: Map<number, ReferenceGroupBinding>;
}

const tabIds = ['T0', 'T1', 'T2'];
const eventArbitrary = fc.oneof(
  fc.record({
    type: fc.constant('activate' as const),
    tab: fc.constantFrom(...tabIds),
  }),
  fc.record({
    type: fc.constant('close' as const),
    tab: fc.constantFrom(...tabIds),
  }),
  fc.record({
    type: fc.constant('group' as const),
    tab: fc.constantFrom(...tabIds),
    group: fc.integer({ min: 1, max: 2 }),
  }),
  fc.record({
    type: fc.constant('ungroup' as const),
    tab: fc.constantFrom(...tabIds),
  }),
  fc.constant({ type: 'reload' as const })
);

describe('Workspace state-space reference model', () => {
  it('keeps the fixed event-order matrix converged', async () => {
    const sequences: Event[][] = [
      [
        { type: 'activate', tab: 'T0' },
        { type: 'group', tab: 'T0', group: 1 },
        { type: 'group', tab: 'T1', group: 1 },
        { type: 'activate', tab: 'T0' },
        { type: 'activate', tab: 'T1' },
        { type: 'close', tab: 'T0' },
      ],
      [
        { type: 'activate', tab: 'T1' },
        { type: 'reload' },
        { type: 'activate', tab: 'T1' },
        { type: 'group', tab: 'T1', group: 2 },
        { type: 'activate', tab: 'T1' },
        { type: 'reload' },
      ],
      [
        { type: 'close', tab: 'T0' },
        { type: 'activate', tab: 'T0' },
        { type: 'activate', tab: 'T2' },
        { type: 'close', tab: 'T2' },
        { type: 'activate', tab: 'T1' },
      ],
    ];

    for (const sequence of sequences) {
      const system = createRealSystem();
      const reference = createReferenceState();
      try {
        for (const event of sequence) {
          await applyEvent(reference, system, event);
          await assertConverged(reference, system);
        }
      } finally {
        await system.runtime.dispose();
      }
    }
  });

  it('matches the reference model for bounded tab/group/reload event sequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(eventArbitrary, { minLength: 1, maxLength: 6 }),
        async (sequence) => {
          const system = createRealSystem();
          const reference = createReferenceState();
          try {
            for (const event of sequence) {
              await applyEvent(reference, system, event);
              await assertConverged(reference, system);
            }
          } finally {
            await system.runtime.dispose();
          }
        }
      ),
      {
        numRuns: process.env.STATE_SPACE_DEEP === '1' ? 300 : 50,
        interruptAfterTimeLimit: 20_000,
      }
    );
  });
});

function createReferenceState(): ReferenceState {
  return {
    tabs: tabIds.map((id) => ({ id })),
    activeTabId: 'T0',
    nextSession: 1,
    tabBindings: new Map(),
    groupBindings: new Map(),
  };
}

function createRealSystem() {
  const workspace = createTestWorkspace({
    model: async () => events(...text('unused')),
    tools: [],
  });
  let tabs: TabDescriptor[] = tabIds.map((id) => ({
    id,
    active: id === 'T0',
    windowId: 1,
  }));
  let sequence = 0;
  const storage = memoryStorage();
  const browser = {
    listTabs: async () => tabs.map((tab) => ({ ...tab })),
    getTab: async (tabId: string) => {
      const tab = tabs.find((item) => item.id === tabId);
      return tab ? { ...tab } : null;
    },
    setWorkingTab: async (sessionId: string, tabId: string) => {
      browserState.set(sessionId, tabId);
    },
    releaseSession: async (sessionId: string) => {
      browserState.delete(sessionId);
    },
  } as unknown as BrowserProvider;
  const browserState = new Map<string, string>();
  const createRegistry = (): TabSessionRegistry =>
    new TabSessionRegistry({
      runtime: workspace.runtime,
      browser,
      storage,
      createSessionId: () => `session_${++sequence}`,
    });

  return {
    runtime: workspace.runtime,
    tabs: () => tabs,
    setActive(tabId: string) {
      tabs = tabs.map((tab) => ({ ...tab, active: tab.id === tabId }));
    },
    remove(tabId: string) {
      tabs = tabs.filter((tab) => tab.id !== tabId).map((tab) => ({
        ...tab,
        active: false,
      }));
    },
    setGroup(tabId: string, groupId?: number) {
      tabs = tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              ...(groupId === undefined ? { groupId: undefined } : { groupId }),
            }
          : tab
      );
    },
    registry: createRegistry(),
    reload() {
      this.registry = createRegistry();
    },
  };
}

async function applyEvent(
  model: ReferenceState,
  system: ReturnType<typeof createRealSystem>,
  event: Event
): Promise<void> {
  if (event.type === 'reload') {
    system.reload();
    return;
  }
  const tab = model.tabs.find((item) => item.id === event.tab);
  if (event.type !== 'activate' && event.type !== 'group' && !tab) return;
  if (event.type === 'activate') {
    if (!tab) return;
    model.activeTabId = tab.id;
    system.setActive(tab.id);
    const expected = resolveSession(model, tab);
    const actual = await system.registry.resolve({
      windowId: 1,
      tabId: tab.id,
      ...(tab.groupId === undefined ? {} : { groupId: tab.groupId }),
    });
    assert.equal(actual.sessionId, expected);
    return;
  }
  if (event.type === 'close') {
    model.tabs = model.tabs.filter((item) => item.id !== tab!.id);
    model.tabBindings.delete(tab!.id);
    if (model.activeTabId === tab!.id) model.activeTabId = undefined;
    reconcileModelGroups(model);
    system.remove(tab!.id);
    await system.registry.forget({ windowId: 1, tabId: tab!.id });
    return;
  }
  if (event.type === 'group') {
    if (!tab) return;
    tab.groupId = event.group;
    system.setGroup(tab.id, event.group);
    await system.registry.reconcile({
      windowId: 1,
      tabId: tab.id,
      groupId: event.group,
    });
    reconcileModelGroups(model);
    return;
  }
  if (event.type === 'ungroup') {
    if (!tab) return;
    tab.groupId = undefined;
    system.setGroup(tab.id);
    await system.registry.reconcile({ windowId: 1, tabId: tab.id });
    reconcileModelGroups(model);
  }
}

function resolveSession(model: ReferenceState, tab: ReferenceTab): string {
  if (tab.groupId !== undefined) {
    let group = model.groupBindings.get(tab.groupId);
    if (!group) {
      const promoted = model.tabBindings.get(tab.id);
      model.tabBindings.delete(tab.id);
      const sessionId = promoted ?? `session_${model.nextSession++}`;
      group = {
        sessionId,
        activeTabId: tab.id,
        memberTabIds: [],
      };
      model.groupBindings.set(tab.groupId, group);
    }
    group.activeTabId = tab.id;
    group.memberTabIds = model.tabs
      .filter((item) => item.groupId === tab.groupId)
      .map((item) => item.id);
    return group.sessionId;
  }
  let sessionId = model.tabBindings.get(tab.id);
  if (!sessionId) {
    sessionId = `session_${model.nextSession++}`;
    model.tabBindings.set(tab.id, sessionId);
  }
  return sessionId;
}

function reconcileModelGroups(model: ReferenceState): void {
  for (const [groupId, binding] of model.groupBindings) {
    const members = model.tabs
      .filter((tab) => tab.groupId === groupId)
      .map((tab) => tab.id);
    if (members.length === 0) {
      model.groupBindings.delete(groupId);
      continue;
    }
    binding.memberTabIds = members;
    if (!members.includes(binding.activeTabId)) binding.activeTabId = members[0];
  }
}

async function assertConverged(
  model: ReferenceState,
  system: ReturnType<typeof createRealSystem>
): Promise<void> {
  const actual = await system.registry.list();
  const actualTab = new Map(
    actual
      .filter((binding) => binding.scope === 'tab')
      .map((binding) => [binding.activeTabId, binding.sessionId])
  );
  const actualGroup = new Map(
    actual
      .filter((binding) => binding.scope === 'group')
      .map((binding) => [binding.groupId!, binding])
  );

  assert.deepEqual(
    [...actualTab.entries()].sort(),
    [...model.tabBindings.entries()].sort()
  );
  assert.deepEqual(
    [...actualGroup.keys()].sort(),
    [...model.groupBindings.keys()].sort()
  );
  for (const [groupId, expected] of model.groupBindings) {
    const binding = actualGroup.get(groupId);
    assert.ok(binding);
    assert.equal(binding.sessionId, expected.sessionId);
    assert.equal(binding.activeTabId, expected.activeTabId);
    assert.deepEqual(
      [...binding.memberTabIds].sort(),
      [...expected.memberTabIds].sort()
    );
  }
  for (const binding of actual) {
    if (binding.scope === 'tab') {
      assert.ok(
        model.tabs.some((tab) => tab.id === binding.activeTabId),
        `dead standalone target ${binding.activeTabId}`
      );
    }
  }
}

function memoryStorage(): TabSessionStorage {
  const values = new Map<string, unknown>();
  return {
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
