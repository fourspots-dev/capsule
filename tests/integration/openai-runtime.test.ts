import { describe, expect, it } from 'vitest';
import { OpenAIModelTransport } from '../../src/adapters/openai-model';
import {
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
} from '../../src/core';
import { FakeApproval, FakeClock, readTool } from '../harness/fakes';
import { command } from '../harness/workspace';

function sse(value: unknown, done = true): Response {
  const body = `data: ${JSON.stringify(value)}\n\n${done ? 'data: [DONE]\n\n' : ''}`;
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('OpenAI transport with WorkspaceRuntime', () => {
  it('completes a model-tool-model loop without adapters leaking into the core', async () => {
    let requestCount = 0;
    const model = new OpenAIModelTransport({
      baseUrl: 'https://model.example/v1',
      model: 'test-model',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 1) {
          return sse({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'read', arguments: '{"text":"body"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          });
        }
        return sse({
          choices: [{ delta: { content: 'Read complete.' }, finish_reason: 'stop' }],
        });
      },
    });
    const tools = new ToolExecutor([readTool('read', async () => 'page body')], new FakeApproval());
    const runtime = new WorkspaceRuntime({
      model,
      tools,
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
    });

    const ack = await runtime.command(command('session_1', 'command_1', 'Read the page'));
    expect(ack.status).toBe('accepted');
    await runtime.waitForSessionIdle('session_1');

    expect(runtime.getProjection('session_1').rows.map((row) => row.text)).toEqual([
      'Read the page',
      'Thinking complete',
      '',
      'page body',
      'Thinking complete',
      'Read complete.',
    ]);
    expect(requestCount).toBe(2);
  });
});
