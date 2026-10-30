import { describe, expect, it } from 'vitest';
import { OpenAIModelTransport } from '../../src/adapters/openai-model';
import type { ModelEvent, ModelRequest } from '../../src/core';

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    sessionId: 'session_1',
    taskId: 'task_1',
    messages: [{ role: 'user', content: 'inspect' }],
    tools: [
      {
        name: 'read',
        description: 'Read a page',
        parameters: {
          type: 'object',
          properties: { selector: { type: 'string' } },
        },
      },
    ],
    signal: new AbortController().signal,
    ...overrides,
  };
}

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }),
    { status, headers: { 'Content-Type': 'text/event-stream' } }
  );
}

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const result: ModelEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe('OpenAIModelTransport', () => {
  it('normalizes text and fragmented tool calls across arbitrary SSE chunks', async () => {
    let sent: { input: RequestInfo | URL; init?: RequestInit } | undefined;
    const payload =
      'data: {"choices":[{"delta":{"content":"Let me "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"check.","tool_calls":[{"index":0,"id":"call_1",' +
      '"function":{"name":"read","arguments":"{\\"selector\\":\\"body\\"}"}}]}}]}\n\n' +
      'data: {"choices":[{"finish_reason":"tool_calls"}]}\n\n' +
      'data: [DONE]\n\n';
    const transport = new OpenAIModelTransport({
      baseUrl: 'https://model.example/v1/',
      model: 'test-model',
      apiKey: 'secret',
      fetch: async (input, init) => {
        sent = { input, init };
        return sseResponse([
          payload.slice(0, 73),
          payload.slice(73, 181),
          payload.slice(181),
        ]);
      },
    });

    const events = await collect(transport.stream(request()));
    expect(events).toEqual([
      { type: 'text_delta', text: 'Let me ' },
      { type: 'text_delta', text: 'check.' },
      {
        type: 'tool_call',
        call: { id: 'call_1', name: 'read', arguments: '{"selector":"body"}' },
      },
      { type: 'finish', reason: 'tool_calls' },
    ]);

    const init = sent?.init;
    expect(String(sent?.input)).toBe('https://model.example/v1/chat/completions');
    expect(init?.headers).toMatchObject({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toMatchObject({
      model: 'test-model',
      stream: true,
      messages: [{ role: 'user', content: 'inspect' }],
      tools: [{ type: 'function', function: { name: 'read' } }],
    });
  });

  it('serializes assistant tool calls and tool results in OpenAI message format', async () => {
    let body: any;
    const transport = new OpenAIModelTransport({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetch: async (_input, init) => {
        body = JSON.parse(String(init?.body));
        return sseResponse(['data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n']);
      },
    });
    await collect(
      transport.stream(
        request({
          messages: [
            { role: 'user', content: 'read' },
            {
              role: 'assistant',
              content: '',
              toolCalls: [{ id: 'call_1', name: 'read', arguments: '{"selector":"body"}' }],
            },
            { role: 'tool', callId: 'call_1', name: 'read', content: 'page body' },
          ],
        })
      )
    );
    expect(body.messages).toEqual([
      { role: 'user', content: 'read' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read', arguments: '{"selector":"body"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', name: 'read', content: 'page body' },
    ]);
  });

  it('returns a structured HTTP error without leaking credentials', async () => {
    const transport = new OpenAIModelTransport({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      apiKey: 'do-not-log',
      fetch: async () =>
        new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    });
    const events = await collect(transport.stream(request()));
    expect(events).toEqual([
      {
        type: 'error',
        error: {
          code: 'MODEL_HTTP_429',
          message: 'Model API HTTP 429: rate limited',
          retryable: true,
          details: { status: 429 },
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('do-not-log');
  });

  it('propagates abort through fetch', async () => {
    const controller = new AbortController();
    const transport = new OpenAIModelTransport({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetch: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            },
            { once: true }
          );
        }),
    });
    const stream = transport.stream(request({ signal: controller.signal }));
    const first = stream[Symbol.asyncIterator]().next();
    controller.abort();
    await expect(first).resolves.toMatchObject({
      done: false,
      value: {
        type: 'error',
        error: { code: 'MODEL_ABORTED', retryable: false },
      },
    });
  });
});
