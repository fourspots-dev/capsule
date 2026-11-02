import type { BrowserProvider } from './browser-provider';
import type { TabDescriptor } from './browser-provider';
import { AgentError } from '../core/errors';
import type { SessionAccessPort } from '../platform/workspace';

const DEFAULT_STORAGE_KEY = 'tinyai:tab-sessions:v1';

export interface TabContext {
  windowId: number;
  tabId: string;
  groupId?: number;
}

export interface TabSessionBinding {
  scope: 'group' | 'tab';
  windowId: number;
  groupId?: number;
  activeTabId: string;
  memberTabIds: string[];
  sessionId: string;
  updatedAt: number;
}

export interface TabSessionStorage {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

export interface TabSessionRegistryOptions {
  runtime: SessionAccessPort;
  browser: BrowserProvider;
  storage?: TabSessionStorage;
  storageKey?: string;
  now?: () => number;
  createSessionId?: () => string;
}

export class TabSessionRegistry {
  private readonly bindings = new Map<string, TabSessionBinding>();
  private readonly storageKey: string;
  private readonly now: () => number;
  private readonly createSessionId: () => string;
  private loaded?: Promise<void>;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: TabSessionRegistryOptions) {
    this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
    this.now = options.now ?? Date.now;
    this.createSessionId =
      options.createSessionId ?? (() => `session_${crypto.randomUUID()}`);
  }

  resolve(context: TabContext): Promise<TabSessionBinding> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const target = await this.options.browser.getTab(context.tabId);
      if (!target) {
        const key = tabKey(context);
        if (this.bindings.get(key)?.scope === 'tab') {
          this.bindings.delete(key);
          await this.persist();
        }
        throw new AgentError(
          'BROWSER_TAB_NOT_FOUND',
          `Tab not found: ${context.tabId}`
        );
      }
      const existing = this.bindings.get(tabKey(context));
      if (existing) {
        if (
          existing.scope === 'group' &&
          existing.groupId !== undefined &&
          existing.memberTabIds.length > 0
        ) {
          const members = (await this.options.browser.listTabs())
            .filter(
              (tab) =>
                tab.windowId === existing.windowId &&
                tab.groupId === existing.groupId
            )
            .map((tab) => tab.id);
          if (
            members.length > 0 &&
            !members.some((tabId) => existing.memberTabIds.includes(tabId))
          ) {
            this.bindings.delete(tabKey(context));
          }
        }
      }
      const currentBinding = this.bindings.get(tabKey(context));
      if (currentBinding) {
        const session = await this.options.runtime.hydrateSession(currentBinding.sessionId);
        if (session) {
          await this.options.runtime.ensureSessionReady(currentBinding.sessionId);
          await this.options.browser.setWorkingTab(currentBinding.sessionId, context.tabId, {
            activate: false,
          });
          return this.refreshBinding(currentBinding, context);
        }
        this.bindings.delete(tabKey(context));
      }
      if (context.groupId !== undefined && context.groupId >= 0) {
        const promoted = this.bindings.get(
          tabKey({ windowId: context.windowId, tabId: context.tabId })
        );
        if (promoted) {
          this.bindings.delete(
            tabKey({ windowId: context.windowId, tabId: context.tabId })
          );
          return this.bindLocked(context, promoted.sessionId);
        }
      }
      return this.createLocked(context);
    });
  }

  create(context: TabContext): Promise<TabSessionBinding> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      return this.createLocked(context);
    });
  }

  bind(context: TabContext, sessionId: string): Promise<TabSessionBinding> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const session = await this.options.runtime.hydrateSession(sessionId);
      if (!session) {
        throw new AgentError(
          'SESSION_NOT_FOUND',
          `Session not found: ${sessionId}`
        );
      }
      return this.bindLocked(context, sessionId);
    });
  }

  forget(context: TabContext): Promise<void> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      await this.forgetLocked(context);
    });
  }

  reconcile(context: TabContext): Promise<void> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const tab = await this.options.browser.getTab(context.tabId);
      if (!tab) {
        await this.forgetLocked(context);
        return;
      }
      const tabs = await this.options.browser.listTabs();
      let changed = false;
      for (const [key, binding] of this.bindings) {
        if (binding.scope !== 'group' || binding.windowId !== context.windowId) {
          continue;
        }
        const members = tabs.filter(
          (candidate) =>
            candidate.windowId === binding.windowId &&
            candidate.groupId === binding.groupId
        );
        if (members.length === 0) {
          this.bindings.delete(key);
          changed = true;
        } else {
          binding.memberTabIds = members.map((candidate) => candidate.id);
          if (!binding.memberTabIds.includes(binding.activeTabId)) {
            binding.activeTabId = binding.memberTabIds[0];
          }
          binding.updatedAt = this.now();
          changed = true;
        }
      }
      if (changed) await this.persist();
    });
  }

  releaseSession(sessionId: string): Promise<void> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      let changed = false;
      for (const [key, binding] of this.bindings) {
        if (binding.sessionId !== sessionId) continue;
        this.bindings.delete(key);
        changed = true;
      }
      await this.options.browser.releaseSession?.(sessionId);
      if (changed) await this.persist();
    });
  }

  clear(): Promise<void> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const sessionIds = new Set(
        [...this.bindings.values()].map((binding) => binding.sessionId)
      );
      await Promise.all(
        [...sessionIds].map((sessionId) =>
          this.options.browser.releaseSession?.(sessionId)
        )
      );
      this.bindings.clear();
      await this.options.storage?.remove?.(this.storageKey);
    });
  }

  async list(): Promise<TabSessionBinding[]> {
    await this.ensureLoaded();
    return [...this.bindings.values()].map((binding) => ({ ...binding }));
  }

  async createTab(sessionId: string, url = 'about:blank'): Promise<TabDescriptor> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      const existing = [...this.bindings.values()].find(
        (binding) => binding.sessionId === sessionId
      );
      if (!existing) {
        throw new AgentError(
          'WORKSPACE_NOT_FOUND',
          `No browser workspace is bound to session ${sessionId}`
        );
      }
      const tab = await this.options.browser.createTab(url, { active: false });
      const group = await this.options.browser.addTabToSession?.(
        sessionId,
        tab.id,
        { owned: true, baseTabId: existing.activeTabId }
      );
      if (!group) {
        throw new AgentError(
          'WORKSPACE_GROUP_UNAVAILABLE',
          'The browser adapter cannot add tabs to a workspace'
        );
      }
      const tabs = (await this.options.browser.listSessionTabs?.(sessionId)) ?? [tab];
      this.removeBindings(sessionId);
      const binding: TabSessionBinding = {
        scope: 'group',
        windowId: group.groupId !== undefined
          ? (tab.windowId ?? existing.windowId)
          : existing.windowId,
        ...(group.groupId !== undefined ? { groupId: group.groupId } : {}),
        activeTabId: tab.id,
        memberTabIds: tabs.map((item) => item.id),
        sessionId,
        updatedAt: this.now(),
      };
      this.bindings.set(tabKeyFromBinding(binding), binding);
      await this.persist();
      await this.options.browser.setWorkingTab(sessionId, tab.id, {
        activate: true,
      });
      return {
        ...tab,
        active: true,
        ...(group.groupId !== undefined ? { groupId: group.groupId } : {}),
      };
    });
  }

  async switchTab(sessionId: string, tabId: string): Promise<void> {
    return this.serialized(async () => {
      await this.ensureLoaded();
      await this.options.browser.assertSessionTab?.(sessionId, tabId);
      await this.options.browser.setWorkingTab(sessionId, tabId, {
        activate: true,
      });
      const binding = [...this.bindings.values()].find(
        (item) => item.sessionId === sessionId
      );
      if (binding) {
        binding.activeTabId = tabId;
        binding.updatedAt = this.now();
        await this.persist();
      }
    });
  }

  async listTabs(sessionId: string): Promise<TabDescriptor[]> {
    await this.ensureLoaded();
    return (await this.options.browser.listSessionTabs?.(sessionId)) ?? [];
  }

  private async createLocked(context: TabContext): Promise<TabSessionBinding> {
    return this.bindLocked(context, this.createSessionId());
  }

  private async bindLocked(
    context: TabContext,
    sessionId: string
  ): Promise<TabSessionBinding> {
    const key = tabKey(context);
    for (const [existingKey, binding] of this.bindings) {
      if (existingKey !== key && binding.sessionId === sessionId) {
        this.bindings.delete(existingKey);
      }
    }
    await this.options.runtime.ensureSessionReady(sessionId);
    await this.options.browser.setWorkingTab(sessionId, context.tabId, {
      activate: false,
    });
    const groupTabs =
      context.groupId !== undefined && context.groupId >= 0
        ? await this.options.browser.listTabs()
        : [];
    const binding: TabSessionBinding = {
      scope: context.groupId !== undefined && context.groupId >= 0 ? 'group' : 'tab',
      windowId: context.windowId,
      ...(context.groupId !== undefined && context.groupId >= 0
        ? { groupId: context.groupId }
        : {}),
      activeTabId: context.tabId,
      memberTabIds:
        context.groupId !== undefined && context.groupId >= 0
          ? groupTabs
              .filter(
                (tab) =>
                  tab.windowId === context.windowId &&
                  tab.groupId === context.groupId
              )
              .map((tab) => tab.id)
          : [context.tabId],
      sessionId,
      updatedAt: this.now(),
    };
    this.bindings.set(key, binding);
    await this.persist();
    return { ...binding };
  }

  private async ensureLoaded(): Promise<void> {
    this.loaded ??= this.load();
    await this.loaded;
  }

  private async refreshBinding(
    binding: TabSessionBinding,
    context: TabContext
  ): Promise<TabSessionBinding> {
    binding.activeTabId = context.tabId;
    binding.updatedAt = this.now();
    if (binding.scope === 'group' && binding.groupId !== undefined) {
      const tabs = await this.options.browser.listTabs();
      binding.memberTabIds = tabs
        .filter(
          (tab) =>
            tab.windowId === binding.windowId &&
            tab.groupId === binding.groupId
        )
        .map((tab) => tab.id);
    }
    await this.persist();
    return {
      ...binding,
      memberTabIds: [...binding.memberTabIds],
    };
  }

  private async load(): Promise<void> {
    if (!this.options.storage) return;
    const stored = await this.options.storage.get(this.storageKey);
    const raw = stored[this.storageKey];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const windowId = Number(item.windowId);
      const groupId = Number(item.groupId);
      const tabId =
        typeof item.activeTabId === 'string'
          ? item.activeTabId
          : typeof item.tabId === 'string'
            ? item.tabId
            : '';
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
      if (!Number.isFinite(windowId) || !tabId || !sessionId) continue;
      const scopedGroupId = Number.isFinite(groupId) && groupId >= 0 ? groupId : undefined;
      const context = { windowId, tabId, ...(scopedGroupId !== undefined ? { groupId: scopedGroupId } : {}) };
      this.bindings.set(tabKey(context), {
        scope: scopedGroupId !== undefined ? 'group' : 'tab',
        windowId,
        ...(scopedGroupId !== undefined ? { groupId: scopedGroupId } : {}),
        activeTabId: tabId,
        memberTabIds: Array.isArray(item.memberTabIds)
          ? item.memberTabIds.map(String)
          : [tabId],
        sessionId,
        updatedAt: Number(item.updatedAt ?? this.now()),
      });
    }
  }

  private async persist(): Promise<void> {
    if (!this.options.storage) return;
    await this.options.storage.set({
      [this.storageKey]: [...this.bindings.values()].map((binding) => ({
        ...binding,
      })),
    });
  }

  private removeBindings(sessionId: string): void {
    for (const [key, binding] of this.bindings) {
      if (binding.sessionId === sessionId) this.bindings.delete(key);
    }
  }

  private async forgetLocked(context: TabContext): Promise<void> {
    let changed = this.bindings.delete(
      tabKey({ windowId: context.windowId, tabId: context.tabId })
    );
    const tabs = await this.options.browser.listTabs();
    for (const [key, binding] of this.bindings) {
      if (binding.scope !== 'group' || binding.windowId !== context.windowId) {
        continue;
      }
      const members = tabs.filter(
        (tab) =>
          tab.windowId === binding.windowId &&
          tab.groupId === binding.groupId
      );
      if (members.length === 0) {
        this.bindings.delete(key);
        changed = true;
      } else {
        binding.memberTabIds = members.map((tab) => tab.id);
        if (!binding.memberTabIds.includes(binding.activeTabId)) {
          binding.activeTabId = binding.memberTabIds[0];
        }
        binding.updatedAt = this.now();
        changed = true;
      }
    }
    if (changed) await this.persist();
  }

  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation, operation);
    this.tail = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }
}

function tabKey(context: TabContext): string {
  return context.groupId !== undefined && context.groupId >= 0
    ? `group:${context.windowId}:${context.groupId}`
    : `tab:${context.windowId}:${context.tabId}`;
}

function tabKeyFromBinding(binding: TabSessionBinding): string {
  return binding.scope === 'group' && binding.groupId !== undefined
    ? `group:${binding.windowId}:${binding.groupId}`
    : `tab:${binding.windowId}:${binding.activeTabId}`;
}
