import { describe, expect, it } from 'vitest';
import { OpenAIModelTransport } from '../../src/adapters/openai-model';
import type { ModelEvent } from '../../src/core';

const apiKey = process.env.DEEPSEEK_API_KEY;
const liveTest = apiKey ? it : it.skip;

describe('DeepSeek live smoke', () => {
  liveTest('returns a normalized stream without assuming exact model wording', async () => {
    const transport = new OpenAIModelTransport({
      baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
      apiKey,
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    });
    const events: ModelEvent[] = [];
    for await (const event of transport.stream({
      sessionId: 'live_session',
      taskId: 'live_task',
      messages: [
        {
          role: 'user',
          content: 'Reply with one short sentence confirming the transport is working.',
        },
      ],
      tools: [],
      signal: new AbortController().signal,
    })) {
      events.push(event);
    }

    expect(events.find((event) => event.type === 'error')).toBeUndefined();
    expect(
      events.some((event) => event.type === 'text_delta' && event.text.trim()) ||
        events.some((event) => event.type === 'finish')
    ).toBe(true);
  }, 30_000);
});
