import type { RuntimeEvent } from './event-log';
import type { SessionEntry } from './session-tree';
import type { TaskNode } from './task-graph';
import type { PlanSnapshot } from './policy';
import type {
  ChildTaskProjection,
  CommandAck,
  ConversationRow,
  InputLedgerEntry,
  ModelMessage,
  TaskStatus,
} from './types';

export interface SessionSnapshot {
  schemaVersion: 1;
  sessionId: string;
  logEpoch: string;
  revision: number;
  eventSeq: number;
  taskStatus: TaskStatus;
  messages: ModelMessage[];
  rows: ConversationRow[];
  ledger: InputLedgerEntry[];
  events: RuntimeEvent[];
  commands?: CommandAck[];
  sessionEntries?: SessionEntry[];
  activeLeafId?: string | null;
  tasks?: TaskNode[];
  permission?: PlanSnapshot;
  title?: string;
  children?: ChildTaskProjection[];
}

export interface SessionStore {
  load(sessionId: string): Promise<SessionSnapshot | undefined>;
  save(snapshot: SessionSnapshot): Promise<void>;
  remove(sessionId: string): Promise<void>;
  clear?(): Promise<void>;
  list?(): Promise<SessionSummary[]>;
}

export interface SessionSummary {
  sessionId: string;
  revision: number;
  eventSeq: number;
  taskStatus: TaskStatus;
  updatedAt: number;
  title: string;
  rowCount: number;
  childCount: number;
  attentionCount: number;
}

export class InMemorySessionStore implements SessionStore {
  private readonly snapshots = new Map<string, SessionSnapshot>();

  async load(sessionId: string): Promise<SessionSnapshot | undefined> {
    const snapshot = this.snapshots.get(sessionId);
    return snapshot ? cloneSnapshot(snapshot) : undefined;
  }

  async save(snapshot: SessionSnapshot): Promise<void> {
    this.snapshots.set(snapshot.sessionId, cloneSnapshot(snapshot));
  }

  async remove(sessionId: string): Promise<void> {
    this.snapshots.delete(sessionId);
  }

  async clear(): Promise<void> {
    this.snapshots.clear();
  }

  async list(): Promise<SessionSummary[]> {
    return [...this.snapshots.values()].map(summarizeSnapshot);
  }
}

export function summarizeSnapshot(snapshot: SessionSnapshot): SessionSummary {
  const firstUser = snapshot.rows.find((row) => row.kind === 'user' && row.text.trim());
  const children = snapshot.children ?? [];
  return {
    sessionId: snapshot.sessionId,
    revision: snapshot.revision,
    eventSeq: snapshot.eventSeq,
    taskStatus: snapshot.taskStatus,
    updatedAt: snapshot.events.at(-1)?.occurredAt ?? 0,
    title: snapshot.title?.trim() || firstUser?.text.slice(0, 80) || 'New chat',
    rowCount: snapshot.rows.length,
    childCount: children.length,
    attentionCount: children.filter(
      (child) => child.status === 'failed' || child.status === 'cancelled'
    ).length,
  };
}

export function cloneSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    messages: snapshot.messages.map((message) =>
      message.role === 'assistant' && message.toolCalls
        ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) }
        : { ...message }
    ),
    rows: snapshot.rows.map((row) => ({ ...row })),
    ledger: snapshot.ledger.map((entry) => ({ ...entry })),
    events: snapshot.events.map((event) => ({ ...event })),
    commands: (snapshot.commands ?? []).map((ack) => ({
      ...ack,
      ...(ack.error ? { error: { ...ack.error } } : {}),
    })),
    sessionEntries: (snapshot.sessionEntries ?? []).map((entry) => ({
      ...entry,
      payload: structuredClone(entry.payload),
    })),
    tasks: (snapshot.tasks ?? []).map((task) => structuredClone(task)),
    children: (snapshot.children ?? []).map((child) => ({ ...child })),
    ...(snapshot.title ? { title: snapshot.title } : {}),
    ...(snapshot.permission ? { permission: { ...snapshot.permission } } : {}),
  };
}
