import { describe, expect, it } from 'vitest';
import { ModelGateway } from '../../src/core/model-gateway';
import type { ModelEvent, ModelRequest } from '../../src/core/types';

function request(): ModelRequest {
  return {
    sessionId: 's',
    taskId: 't',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    signal: new AbortController().signal,
  };
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe('ModelGateway', () => {
  it('retries retryable errors before output and falls back to a second target', async () => {
    let primary = 0;
    const gateway = new ModelGateway({
      delay: async () => undefined,
      targets: [
        {
          id: 'primary',
          attempts: 2,
          transport: {
            async *stream() {
              primary += 1;
              yield {
                type: 'error',
                error: { code: 'MODEL_HTTP_503', message: 'busy', retryable: true },
              };
            },
          },
        },
        {
          id: 'fallback',
          transport: {
            async *stream() {
              yield { type: 'text_delta', text: 'fallback answer' };
              yield { type: 'finish', reason: 'stop' };
            },
          },
        },
      ],
    });
    expect(await collect(gateway.stream(request()))).toEqual([
      { type: 'text_delta', text: 'fallback answer' },
      { type: 'finish', reason: 'stop' },
    ]);
    expect(primary).toBe(2);
  });

  it('does not retry after deltas because output would be duplicated', async () => {
    let attempts = 0;
    const gateway = new ModelGateway({
      delay: async () => undefined,
      targets: [
        {
          id: 'primary',
          attempts: 3,
          transport: {
            async *stream() {
              attempts += 1;
              yield { type: 'text_delta', text: 'partial' };
              yield {
                type: 'error',
                error: { code: 'MODEL_STREAM_FAILED', message: 'broken', retryable: true },
              };
            },
          },
        },
      ],
    });
    expect(await collect(gateway.stream(request()))).toEqual([
      { type: 'text_delta', text: 'partial' },
      {
        type: 'error',
        error: {
          code: 'MODEL_STREAM_FAILED',
          message: 'broken',
          retryable: true,
        },
      },
    ]);
    expect(attempts).toBe(1);
  });
});
