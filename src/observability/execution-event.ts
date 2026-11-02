import type { JsonValue } from '../core/types';

export const EXECUTION_EVENT_SCHEMA_VERSION = 1 as const;

export type ExecutionEventKind =
  | 'session'
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'approval'
  | 'handoff'
  | 'child-agent'
  | 'evidence'
  | 'artifact'
  | 'error'
  | 'status';

export type ExecutionEventPhase =
  | 'started'
  | 'updated'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ExecutionEventActor =
  | 'user'
  | 'agent'
  | 'tool'
  | 'child-agent'
  | 'system';

export interface ExecutionEventInput {
  clientEventId: string;
  timestamp: number;
  sessionId: string;
  taskId?: string;
  productTurnId?: string;
  callId?: string;
  traceId?: string;
  parentId?: string;
  kind: ExecutionEventKind;
  phase: ExecutionEventPhase;
  actor: ExecutionEventActor;
  visibility?: 'public' | 'displayed-reasoning' | 'summary';
  payload?: JsonValue;
}

export interface ExecutionEvent extends ExecutionEventInput {
  schemaVersion: typeof EXECUTION_EVENT_SCHEMA_VERSION;
  eventId: string;
  sequence: number;
  cursor: string;
}

export interface ExecutionCursor {
  version: 1;
  epoch: string;
  sequence: number;
}

export interface ExecutionEventQuery {
  events: ExecutionEvent[];
  nextCursor: string;
  hasMore: boolean;
  truncated: boolean;
  earliestCursor: string;
}

export function encodeExecutionCursor(cursor: ExecutionCursor): string {
  return btoa(
    encodeURIComponent(
      JSON.stringify({
        version: 1,
        epoch: cursor.epoch,
        sequence: cursor.sequence,
      })
    )
  )
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function decodeExecutionCursor(value: string): ExecutionCursor {
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/');
    const decoded = JSON.parse(
      decodeURIComponent(
        atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, '='))
      )
    ) as Partial<ExecutionCursor>;
    if (
      decoded.version !== 1 ||
      typeof decoded.epoch !== 'string' ||
      typeof decoded.sequence !== 'number' ||
      decoded.sequence < 0
    ) {
      throw new Error('invalid cursor fields');
    }
    return {
      version: 1,
      epoch: decoded.epoch,
      sequence: decoded.sequence,
    };
  } catch {
    throw new Error('Invalid execution cursor');
  }
}

export function redactExecutionValue(value: JsonValue | undefined): JsonValue | undefined {
  return value === undefined ? undefined : redact(value, '');
}

function redact(value: JsonValue, key: string): JsonValue {
  if (isSecretKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, ''));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redact(entryValue, entryKey),
      ])
    ) as JsonValue;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return /^(?:api[-_]?key|authorization|cookie|secret|password|token|access[-_]?token|refresh[-_]?token)$/i.test(
    key
  );
}

function redactString(value: string): string {
  return value
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
