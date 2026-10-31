import type { HostStorage } from '../host';
import { AgentError } from '../core/errors';
import {
  cloneSnapshot,
  summarizeSnapshot,
  type SessionSnapshot,
  type SessionStore,
  type SessionSummary,
} from '../core/session-store';

export class HostSessionStore implements SessionStore {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly storage: HostStorage,
    private readonly prefix = 'tinyai:session:v1:'
  ) {}

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const key = this.key(sessionId);
    await this.tails.get(key);
    const raw = await this.storage.get(key);
    return raw === undefined ? undefined : validateSnapshot(raw, sessionId);
  }

  save(snapshot: SessionSnapshot): Promise<void> {
    const stored = cloneSnapshot(snapshot);
    return this.enqueue(this.key(snapshot.sessionId), () =>
      this.storage.set(this.key(snapshot.sessionId), stored)
    );
  }

  remove(sessionId: string): Promise<void> {
    return this.enqueue(this.key(sessionId), () =>
      this.storage.remove(this.key(sessionId))
    );
  }

  async clear(): Promise<void> {
    await Promise.all(this.tails.values());
    const keys = (await this.storage.list?.(this.prefix)) ?? [];
    await Promise.all(keys.map((key) => this.storage.remove(key)));
    this.tails.clear();
  }

  async list(): Promise<SessionSummary[]> {
    const keys = (await this.storage.list?.(this.prefix)) ?? [];
    const summaries: SessionSummary[] = [];
    for (const key of keys) {
      const sessionId = decodeURIComponent(key.slice(this.prefix.length));
      const raw = await this.storage.get(key);
      try {
        summaries.push(summarizeSnapshot(validateSnapshot(raw, sessionId)));
      } catch {
        // Corrupt history entries must not hide unrelated sessions.
      }
    }
    return summaries.sort((left, right) => right.updatedAt - left.updatedAt);
  }

  private key(sessionId: string): string {
    if (!sessionId.trim()) {
      throw new AgentError('SESSION_ID_INVALID', 'Session id cannot be empty');
    }
    return `${this.prefix}${encodeURIComponent(sessionId)}`;
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

function validateSnapshot(raw: unknown, sessionId: string): SessionSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw invalid(sessionId, 'snapshot must be an object');
  }
  const snapshot = raw as Partial<SessionSnapshot>;
  if (snapshot.schemaVersion !== 1 || snapshot.sessionId !== sessionId) {
    throw invalid(sessionId, 'schema or session id mismatch');
  }
  if (
    typeof snapshot.logEpoch !== 'string' ||
    typeof snapshot.revision !== 'number' ||
    typeof snapshot.eventSeq !== 'number' ||
    typeof snapshot.taskStatus !== 'string' ||
    !Array.isArray(snapshot.messages) ||
    !Array.isArray(snapshot.rows) ||
    !Array.isArray(snapshot.ledger) ||
    !Array.isArray(snapshot.events)
  ) {
    throw invalid(sessionId, 'required fields are missing');
  }
  return cloneSnapshot(snapshot as SessionSnapshot);
}

function invalid(sessionId: string, detail: string): AgentError {
  return new AgentError(
    'STORAGE_SNAPSHOT_INVALID',
    `Invalid session snapshot for ${sessionId}: ${detail}`
  );
}
