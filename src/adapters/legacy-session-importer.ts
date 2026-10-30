import type {
  ConversationRow,
  InputLedgerEntry,
  ModelMessage,
  ToolCall,
} from '../core/types';
import type { SessionSnapshot, SessionStore } from '../core/session-store';
import type { SessionEntry, SessionMessagePayload } from '../core/session-tree';

interface LegacyMessage {
  role?: string;
  content?: unknown;
  tool_call_id?: string;
  tool_calls?: Array<{
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

interface LegacyTimeline {
  id?: string;
  kind?: string;
  text?: string;
  name?: string;
  callId?: string;
  state?: string;
  result?: string;
  level?: string;
}

interface LegacySession {
  id?: string;
  title?: string;
  created?: number;
  updated?: number;
  messages?: LegacyMessage[];
  timeline?: LegacyTimeline[];
}

export async function importLegacySessions(
  raw: unknown,
  store: SessionStore,
  now = Date.now()
): Promise<number> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 0;
  const sessions = (raw as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return 0;
  let imported = 0;
  for (const value of sessions) {
    if (!value || typeof value !== 'object') continue;
    const legacy = value as LegacySession;
    const sessionId = legacy.id ? `legacy_${legacy.id}` : `legacy_${now}_${imported}`;
    if (await store.load(sessionId)) continue;
    const snapshot = convertSession(legacy, sessionId, now);
    if (snapshot.rows.length === 0) continue;
    await store.save(snapshot);
    imported += 1;
  }
  return imported;
}

export function convertSession(
  legacy: LegacySession,
  sessionId: string,
  now = Date.now()
): SessionSnapshot {
  const updatedAt = finite(legacy.updated) ?? now;
  const rows: ConversationRow[] = [];
  const ledger: InputLedgerEntry[] = [];
  const entries: SessionEntry[] = [];
  let parentId: string | null = null;
  let entrySequence = 0;
  const appendEntry = (payload: SessionMessagePayload): void => {
    const id = `legacy_entry_${++entrySequence}`;
    entries.push({
      id,
      parentId,
      type: 'message',
      createdAt: updatedAt,
      payload: payload as unknown as import('../core/types').JsonValue,
    });
    parentId = id;
  };

  for (const message of legacy.messages ?? []) {
    const role = message.role;
    if (role !== 'system' && role !== 'user' && role !== 'assistant' && role !== 'tool') continue;
    const content = stringify(message.content);
    if (role === 'assistant') {
      const toolCalls = (message.tool_calls ?? []).map((call, index): ToolCall => ({
        id: call.id ?? `legacy_call_${index + 1}`,
        name: call.function?.name ?? 'unknown',
        arguments: call.function?.arguments ?? '{}',
      }));
      appendEntry({
        role,
        content,
        ...(toolCalls.length
          ? { toolCallIds: toolCalls.map((call) => call.id), toolCalls }
          : {}),
      });
    } else if (role === 'tool') {
      appendEntry({
        role,
        content,
        ...(message.tool_call_id ? { toolCallId: message.tool_call_id } : {}),
      });
    } else {
      appendEntry({ role, content });
    }
  }

  for (const item of legacy.timeline ?? []) {
    const id = item.id ?? `legacy_row_${rows.length + 1}`;
    if (item.kind === 'user') {
      rows.push({
        id,
        entityId: id,
        productTurnId: 'legacy_turn',
        kind: 'user',
        text: item.text ?? '',
        status: 'completed',
      });
      ledger.push({
        inputId: `legacy_input_${rows.length}`,
        sourceCommandId: `legacy_command_${rows.length}`,
        status: 'promoted',
        delivery: 'startNow',
        text: item.text ?? '',
        admittedAt: updatedAt,
      });
    } else if (item.kind === 'assistant') {
      rows.push({
        id,
        entityId: id,
        productTurnId: 'legacy_turn',
        kind: 'assistant',
        text: item.text ?? '',
        status: 'completed',
      });
    } else if (item.kind === 'tool') {
      rows.push({
        id,
        entityId: item.callId ?? id,
        productTurnId: 'legacy_turn',
        kind: 'tool',
        text: item.result ?? '',
        status:
          item.state === 'denied'
            ? 'denied'
            : item.state === 'error'
              ? 'failed'
              : 'completed',
        ...(item.callId ? { callId: item.callId } : {}),
        ...(item.name ? { toolName: item.name } : {}),
      });
    } else if (item.kind === 'notice' && item.text) {
      rows.push({
        id,
        entityId: id,
        productTurnId: 'legacy_turn',
        kind: 'assistant',
        text: item.text,
        status: item.level === 'error' ? 'failed' : 'completed',
      });
    }
  }

  return {
    schemaVersion: 1,
    sessionId,
    logEpoch: `legacy_epoch_${sessionId}`,
    revision: 1,
    eventSeq: 1,
    taskStatus: 'completed',
    messages: convertMessages(legacy.messages ?? []),
    rows,
    ledger,
    events: [
      {
        seq: 1,
        type: 'legacy.imported',
        revision: 1,
        occurredAt: updatedAt,
        payload: { title: legacy.title ?? 'Imported chat' },
      },
    ],
    sessionEntries: entries,
    activeLeafId: parentId,
    tasks: [],
    permission: { mode: 'guarded' },
  };
}

function convertMessages(messages: LegacyMessage[]): ModelMessage[] {
  const converted: ModelMessage[] = [];
  for (const message of messages) {
    const content = stringify(message.content);
    if (message.role === 'system' || message.role === 'user') {
      converted.push({ role: message.role, content });
    } else if (message.role === 'assistant') {
      const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
        id: call.id ?? `legacy_call_${index + 1}`,
        name: call.function?.name ?? 'unknown',
        arguments: call.function?.arguments ?? '{}',
      }));
      converted.push({
        role: 'assistant',
        content,
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    } else if (message.role === 'tool') {
      converted.push({
        role: 'tool',
        callId: message.tool_call_id ?? 'legacy_unknown_call',
        name: 'tool',
        content,
      });
    }
  }
  return converted;
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
