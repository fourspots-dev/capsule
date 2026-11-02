import type {
  ExecutionCursor,
  ExecutionEvent,
  ExecutionEventInput,
  ExecutionEventQuery,
} from './execution-event';
import {
  EXECUTION_EVENT_SCHEMA_VERSION,
  decodeExecutionCursor,
  encodeExecutionCursor,
  redactExecutionValue,
} from './execution-event';

export interface ExecutionEventStore {
  append(event: ExecutionEvent): Promise<void>;
}

export interface ExecutionEventHubOptions {
  epoch?: string;
  initialEvents?: readonly ExecutionEvent[];
  maxEvents?: number;
  store?: ExecutionEventStore;
}

export class ExecutionEventHub {
  private readonly events: ExecutionEvent[] = [];
  private readonly bySession = new Map<string, ExecutionEvent[]>();
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<{
    sessionId: string;
    listener: (event: ExecutionEvent) => void;
  }>();
  private nextSequence = 1;
  private readonly epoch: string;
  private readonly maxEvents: number;

  constructor(private readonly options: ExecutionEventHubOptions = {}) {
    this.epoch =
      options.epoch ??
      `debug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.maxEvents = Math.max(1, options.maxEvents ?? 100_000);
    for (const event of options.initialEvents ?? []) this.restore(event);
  }

  get cursorEpoch(): string {
    return this.epoch;
  }

  async ingest(inputs: readonly ExecutionEventInput[]): Promise<{
    accepted: ExecutionEvent[];
    duplicates: number;
  }> {
    const accepted: ExecutionEvent[] = [];
    let duplicates = 0;
    for (const input of inputs) {
      const key = `${input.sessionId}:${input.clientEventId}`;
      if (this.seen.has(key)) {
        duplicates += 1;
        continue;
      }
      const sequence = this.nextSequence++;
      const event: ExecutionEvent = {
        ...input,
        schemaVersion: EXECUTION_EVENT_SCHEMA_VERSION,
        eventId: `event_${sequence}`,
        sequence,
        cursor: encodeExecutionCursor({
          version: 1,
          epoch: this.epoch,
          sequence,
        }),
        ...(input.payload === undefined
          ? {}
          : { payload: redactExecutionValue(input.payload) }),
      };
      this.restore(event);
      accepted.push({ ...event, payload: structuredClone(event.payload) });
      await this.options.store?.append(event);
    }
    for (const event of accepted) this.notify(event);
    this.enforceRetention();
    return { accepted, duplicates };
  }

  query(
    sessionId: string,
    after?: string,
    limit = 500
  ): ExecutionEventQuery {
    const earliest = this.events[0]?.sequence ?? this.nextSequence;
    const afterSequence = after
      ? this.decodeAfter(after, sessionId)
      : 0;
    const sessionEvents = this.bySession.get(sessionId) ?? [];
    const filtered = sessionEvents.filter(
      (event) => event.sequence > afterSequence
    );
    const bounded = filtered.slice(0, Math.max(1, Math.min(limit, 2_000)));
    const lastSequence =
      bounded.at(-1)?.sequence ?? Math.max(afterSequence, earliest - 1);
    return {
      events: bounded.map(cloneEvent),
      nextCursor: encodeExecutionCursor({
        version: 1,
        epoch: this.epoch,
        sequence: lastSequence,
      }),
      hasMore: filtered.length > bounded.length,
      truncated: afterSequence > 0 && afterSequence < earliest - 1,
      earliestCursor: encodeExecutionCursor({
        version: 1,
        epoch: this.epoch,
        sequence: Math.max(0, earliest - 1),
      }),
    };
  }

  subscribe(
    sessionId: string,
    listener: (event: ExecutionEvent) => void,
    after?: string
  ): { initial: ExecutionEvent[]; unsubscribe: () => void } {
    const afterSequence = after ? this.decodeAfter(after, sessionId) : 0;
    const entry = { sessionId, listener };
    this.listeners.add(entry);
    return {
      initial: (this.bySession.get(sessionId) ?? [])
        .filter((event) => event.sequence > afterSequence)
        .map(cloneEvent),
      unsubscribe: () => this.listeners.delete(entry),
    };
  }

  listSessions(): Array<{
    sessionId: string;
    eventCount: number;
    firstEventAt: number;
    lastEventAt: number;
    lastKind: string;
    lastStatus?: string;
  }> {
    return [...this.bySession.entries()]
      .map(([sessionId, events]) => ({
        sessionId,
        eventCount: events.length,
        firstEventAt: events[0]?.timestamp ?? 0,
        lastEventAt: events.at(-1)?.timestamp ?? 0,
        lastKind: events.at(-1)?.kind ?? 'status',
        lastStatus: events.at(-1)?.phase,
      }))
      .sort((left, right) => right.lastEventAt - left.lastEventAt);
  }

  exportSession(sessionId: string): string {
    return (this.bySession.get(sessionId) ?? [])
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n';
  }

  private restore(event: ExecutionEvent): void {
    this.events.push(event);
    const session = this.bySession.get(event.sessionId) ?? [];
    session.push(event);
    this.bySession.set(event.sessionId, session);
    this.seen.add(`${event.sessionId}:${event.clientEventId}`);
    this.nextSequence = Math.max(this.nextSequence, event.sequence + 1);
  }

  private notify(event: ExecutionEvent): void {
    for (const entry of this.listeners) {
      if (entry.sessionId === event.sessionId) entry.listener(cloneEvent(event));
    }
  }

  private decodeAfter(cursor: string, sessionId: string): number {
    const decoded = decodeExecutionCursor(cursor);
    if (decoded.epoch !== this.epoch) {
      throw new Error('CURSOR_EXPIRED');
    }
    if (!sessionId) return decoded.sequence;
    return decoded.sequence;
  }

  private enforceRetention(): void {
    while (this.events.length > this.maxEvents) {
      const removed = this.events.shift();
      if (!removed) break;
      this.seen.delete(`${removed.sessionId}:${removed.clientEventId}`);
      const session = this.bySession.get(removed.sessionId);
      if (!session) continue;
      const index = session.findIndex((event) => event.eventId === removed.eventId);
      if (index >= 0) session.splice(index, 1);
      if (session.length === 0) this.bySession.delete(removed.sessionId);
    }
  }
}

function cloneEvent(event: ExecutionEvent): ExecutionEvent {
  return structuredClone(event);
}
