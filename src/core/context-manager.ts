import type { SessionTree, SessionMessagePayload } from './session-tree';
import type { ModelMessage } from './types';

export function buildModelContext(tree: SessionTree, systemPrompt = ''): ModelMessage[] {
  const messages: ModelMessage[] = [];
  if (systemPrompt.trim()) messages.push({ role: 'system', content: systemPrompt });
  const context = tree.context();
  for (const item of context.items) {
    if (item.role === 'compaction') {
      messages.push({
        role: 'user',
        content: `(Conversation summary)\n${stringContent(item.content)}`,
      });
      continue;
    }
    const entry = tree.get(item.sourceEntryId);
    if (!entry || entry.type !== 'message') {
      if (item.role === 'user' || item.role === 'assistant' || item.role === 'system') {
        messages.push({ role: item.role, content: stringContent(item.content) });
      }
      continue;
    }
    const payload = entry.payload as unknown as SessionMessagePayload;
    if (payload.role === 'tool') {
      messages.push({
        role: 'tool',
        callId: payload.toolCallId ?? 'unknown_call',
        name: payload.toolName ?? 'tool',
        content: stringContent(item.content),
      });
    } else if (payload.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: stringContent(item.content),
        ...(payload.toolCalls?.length ? { toolCalls: payload.toolCalls.map((call) => ({ ...call })) } : {}),
      });
    } else if (payload.role === 'user' || payload.role === 'system') {
      messages.push({ role: payload.role, content: stringContent(item.content) });
    }
  }
  return messages;
}

function stringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value);
}
