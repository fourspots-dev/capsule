import { AgentError } from '../core/errors';
import {
  cloneSnapshot,
  summarizeSnapshot,
  type SessionSnapshot,
  type SessionStore,
  type SessionSummary,
} from '../core/session-store';

export interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface ChromeSessionStoreOptions {
  storage?: ChromeStorageArea;
  keyPrefix?: string;
}

const DEFAULT_KEY_PREFIX = 'tinyai:session:v1:';

export class ChromeSessionStore implements SessionStore {
  private readonly storage: ChromeStorageArea;
  private readonly keyPrefix: string;
  private readonly tails = new Map<string, Promise<void>>();

  constructor(options: ChromeSessionStoreOptions = {}) {
    this.storage = options.storage ?? defaultChromeStorage();
    this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  }

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const key = this.keyFor(sessionId);
    await this.tails.get(key);
    const result = await this.storage.get(key);
    const raw = result[key];
    if (raw === undefined) return undefined;
    return validateSnapshot(raw, sessionId);
  }

  save(snapshot: SessionSnapshot): Promise<void> {
    const stored = cloneSnapshot(snapshot);
    const key = this.keyFor(snapshot.sessionId);
    return this.enqueue(key, async () => {
      await this.storage.set({ [key]: stored });
    });
  }

  remove(sessionId: string): Promise<void> {
    const key = this.keyFor(sessionId);
    return this.enqueue(key, async () => {
      await this.storage.remove(key);
    });
  }

  async clear(): Promise<void> {
    await Promise.all(this.tails.values());
    const all = await this.storage.get(null);
    const keys = Object.keys(all).filter((key) => key.startsWith(this.keyPrefix));
    if (keys.length) await this.storage.remove(keys);
    this.tails.clear();
  }

  async list(): Promise<SessionSummary[]> {
    const all = await this.storage.get(null);
    const summaries: SessionSummary[] = [];
    for (const [key, value] of Object.entries(all)) {
      if (!key.startsWith(this.keyPrefix)) continue;
      const sessionId = decodeURIComponent(key.slice(this.keyPrefix.length));
      try {
        summaries.push(summarizeSnapshot(validateSnapshot(value, sessionId)));
      } catch {
        // One corrupt session must not hide unrelated history entries.
      }
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  storageKey(sessionId: string): string {
    return this.keyFor(sessionId);
  }

  private keyFor(sessionId: string): string {
    if (!sessionId.trim()) {
      throw new AgentError('SESSION_ID_INVALID', 'Session id cannot be empty');
    }
    return `${this.keyPrefix}${encodeURIComponent(sessionId)}`;
  }

  private enqueue(key: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.catch(() => undefined);
    this.tails.set(key, settled);
    void settled.then(() => {
      if (this.tails.get(key) === settled) this.tails.delete(key);
    });
    return current;
  }
}

function defaultChromeStorage(): ChromeStorageArea {
  const runtime = globalThis as typeof globalThis & {
    chrome?: { storage?: { local?: ChromeStorageArea } };
  };
  const storage = runtime.chrome?.storage?.local;
  if (!storage) {
    throw new AgentError(
      'CHROME_STORAGE_UNAVAILABLE',
      'chrome.storage.local is unavailable; inject a StorageArea for headless use'
    );
  }
  return storage;
}

function validateSnapshot(raw: unknown, sessionId: string): SessionSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalidSnapshot(sessionId, 'stored value is not an object');
  }
  const snapshot = raw as Partial<SessionSnapshot>;
  if (snapshot.schemaVersion !== 1) {
    throw new AgentError(
      'STORAGE_SCHEMA_UNSUPPORTED',
      `Unsupported session snapshot schema: ${String(snapshot.schemaVersion)}`,
      { details: { sessionId, schemaVersion: toJson(snapshot.schemaVersion) } }
    );
  }
  if (snapshot.sessionId !== sessionId) {
    throw invalidSnapshot(sessionId, 'stored session id does not match its key');
  }
  for (const field of ['messages', 'rows', 'ledger', 'events'] as const) {
    if (!Array.isArray(snapshot[field])) {
      throw invalidSnapshot(sessionId, `${field} must be an array`);
    }
  }
  if (snapshot.commands !== undefined && !Array.isArray(snapshot.commands)) {
    throw invalidSnapshot(sessionId, 'commands must be an array when present');
  }
  if (snapshot.sessionEntries !== undefined && !Array.isArray(snapshot.sessionEntries)) {
    throw invalidSnapshot(sessionId, 'sessionEntries must be an array when present');
  }
  if (snapshot.tasks !== undefined && !Array.isArray(snapshot.tasks)) {
    throw invalidSnapshot(sessionId, 'tasks must be an array when present');
  }
  if (
    typeof snapshot.logEpoch !== 'string' ||
    typeof snapshot.revision !== 'number' ||
    typeof snapshot.eventSeq !== 'number' ||
    typeof snapshot.taskStatus !== 'string'
  ) {
    throw invalidSnapshot(sessionId, 'required scalar fields are missing or invalid');
  }
  return cloneSnapshot(snapshot as SessionSnapshot);
}

function invalidSnapshot(sessionId: string, message: string): AgentError {
  return new AgentError('STORAGE_SNAPSHOT_INVALID', `Invalid session snapshot: ${message}`, {
    details: { sessionId },
  });
}

function toJson(value: unknown): string | number | boolean | null {
  return typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    value === null
    ? value
    : String(value);
}
