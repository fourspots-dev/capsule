import type { BrowserProvider } from '../core/browser-provider';
import { AgentError } from '../core/errors';
import type { WorkspaceRuntime } from '../core/workspace-runtime';

const DEFAULT_STORAGE_KEY = 'tinyai:tab-sessions:v1';

export interface TabContext {
  windowId: number;
  tabId: string;
}

export interface TabSessionBinding extends TabContext {
  sessionId: string;
  updatedAt: number;
}

export interface TabSessionStorage {
  get(keys: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

export interface TabSessionRegistryOptions {
  runtime: WorkspaceRuntime;
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
      const existing = this.bindings.get(tabKey(context));
      if (existing) {
        const session = await this.options.runtime.hydrateSession(existing.sessionId);
        if (session) {
          await this.options.runtime.ensureSessionReady(existing.sessionId);
          await this.options.browser.setWorkingTab(existing.sessionId, context.tabId, {
            activate: false,
          });
          return { ...existing };
        }
        this.bindings.delete(tabKey(context));
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
      if (this.bindings.delete(tabKey(context))) await this.persist();
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
    const binding: TabSessionBinding = {
      windowId: context.windowId,
      tabId: context.tabId,
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

  private async load(): Promise<void> {
    if (!this.options.storage) return;
    const stored = await this.options.storage.get(this.storageKey);
    const raw = stored[this.storageKey];
    if (!Array.isArray(raw)) return;
    for (const value of raw) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const item = value as Record<string, unknown>;
      const windowId = Number(item.windowId);
      const tabId = typeof item.tabId === 'string' ? item.tabId : '';
      const sessionId = typeof item.sessionId === 'string' ? item.sessionId : '';
      if (!Number.isFinite(windowId) || !tabId || !sessionId) continue;
      const context = { windowId, tabId };
      this.bindings.set(tabKey(context), {
        ...context,
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
  return `${context.windowId}:${context.tabId}`;
}
