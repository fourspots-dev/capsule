import type { HostStorage } from '../host';
import type { AgentFilter, ReasoningMode, SessionUiState } from './types';

interface PersistedViewState {
  schemaVersion: 1;
  activeSessionId?: string;
  preferences?: {
    reasoningMode?: ReasoningMode;
  };
  sessions: Record<string, SessionUiState>;
}

export interface ViewStateStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export class ViewStateStore {
  private readonly sessions = new Map<string, SessionUiState>();
  private activeSessionId?: string;
  private reasoningMode: ReasoningMode = 'preview';
  private loading?: Promise<void>;

  constructor(
    private readonly storage?: ViewStateStorage,
    private readonly storageKey = 'tinyai:tui:v1:state'
  ) {}

  get active(): string | undefined {
    return this.activeSessionId;
  }

  get preferredReasoningMode(): ReasoningMode {
    return this.reasoningMode;
  }

  async initialize(): Promise<void> {
    this.loading ??= this.load();
    await this.loading;
  }

  async setActive(sessionId: string): Promise<void> {
    await this.initialize();
    this.activeSessionId = sessionId;
  }

  async setReasoningMode(mode: ReasoningMode): Promise<void> {
    await this.initialize();
    this.reasoningMode = mode;
  }

  async get(sessionId: string): Promise<SessionUiState> {
    await this.initialize();
    const existing = this.sessions.get(sessionId);
    if (existing) return cloneState(existing);
    const created = newState(sessionId);
    this.sessions.set(sessionId, created);
    return cloneState(created);
  }

  async update(
    sessionId: string,
    patch: Partial<Omit<SessionUiState, 'sessionId'>>
  ): Promise<SessionUiState> {
    const current = await this.get(sessionId);
    const next: SessionUiState = {
      ...current,
      ...patch,
      sessionId,
      attachments: patch.attachments
        ? patch.attachments.map((item) => ({ ...item }))
        : current.attachments,
      expandedItemIds: patch.expandedItemIds
        ? [...patch.expandedItemIds]
        : current.expandedItemIds,
    };
    this.sessions.set(sessionId, next);
    return cloneState(next);
  }

  async setBoardFilter(sessionId: string, filter: AgentFilter): Promise<void> {
    await this.update(sessionId, { boardFilter: filter });
  }

  async remove(sessionId: string): Promise<void> {
    await this.initialize();
    this.sessions.delete(sessionId);
    if (this.activeSessionId === sessionId) this.activeSessionId = undefined;
  }

  async flush(): Promise<void> {
    if (!this.storage) return;
    await this.initialize();
    const state: PersistedViewState = {
      schemaVersion: 1,
      ...(this.activeSessionId ? { activeSessionId: this.activeSessionId } : {}),
      preferences: { reasoningMode: this.reasoningMode },
      sessions: Object.fromEntries(
        [...this.sessions].map(([id, value]) => [id, cloneState(value)])
      ),
    };
    await this.storage.set(this.storageKey, state);
  }

  private async load(): Promise<void> {
    const raw = await this.storage?.get(this.storageKey);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    const state = raw as Partial<PersistedViewState>;
    if (state.schemaVersion !== 1 || !state.sessions || typeof state.sessions !== 'object') {
      return;
    }
    this.activeSessionId = state.activeSessionId;
    this.reasoningMode =
      state.preferences?.reasoningMode === 'hidden' ||
      state.preferences?.reasoningMode === 'full'
        ? state.preferences.reasoningMode
        : 'preview';
    for (const [sessionId, value] of Object.entries(state.sessions)) {
      if (!value || typeof value !== 'object') continue;
      this.sessions.set(sessionId, normalizeState(sessionId, value as Partial<SessionUiState>));
    }
  }
}

export class HostViewStateStorage implements ViewStateStorage {
  constructor(private readonly storage: HostStorage) {}

  get(key: string): Promise<unknown> {
    return this.storage.get(key);
  }

  set(key: string, value: unknown): Promise<void> {
    return this.storage.set(key, value);
  }
}

function newState(sessionId: string): SessionUiState {
  return {
    sessionId,
    draftText: '',
    cursor: 0,
    attachments: [],
    expandedItemIds: [],
    lastSeenEventSeq: 0,
    boardFilter: 'all',
  };
}

function normalizeState(
  sessionId: string,
  value: Partial<SessionUiState>
): SessionUiState {
  const fallback = newState(sessionId);
  return {
    ...fallback,
    ...value,
    sessionId,
    attachments: Array.isArray(value.attachments) ? value.attachments : [],
    expandedItemIds: Array.isArray(value.expandedItemIds)
      ? value.expandedItemIds.filter((id): id is string => typeof id === 'string')
      : [],
    draftText: typeof value.draftText === 'string' ? value.draftText : '',
    cursor: typeof value.cursor === 'number' ? value.cursor : 0,
    lastSeenEventSeq:
      typeof value.lastSeenEventSeq === 'number' ? value.lastSeenEventSeq : 0,
    boardFilter: ['all', 'active', 'attention', 'done'].includes(
      String(value.boardFilter)
    )
      ? value.boardFilter!
      : 'all',
  };
}

function cloneState(value: SessionUiState): SessionUiState {
  return {
    ...value,
    attachments: value.attachments.map((item) => ({ ...item })),
    expandedItemIds: [...value.expandedItemIds],
  };
}
