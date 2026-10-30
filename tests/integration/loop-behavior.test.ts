import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  SequentialIdGenerator,
  ToolExecutor,
  type AgentLoopEvent,
} from '../../src/core';
import {
  FakeApproval,
  FakeModelTransport,
  events,
  readTool,
  text,
  toolCall,
  until,
} from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

describe('Pi behavior baseline', () => {
  it('executes a parallel batch with completion-order events and source-order messages', async () => {
    const starts: string[] = [];
    const ends: string[] = [];
    const tools = new ToolExecutor(
      [
        {
          ...readTool('slow', async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            return 'slow result';
          }),
          executionMode: 'parallel',
        },
        {
          ...readTool('fast', async () => 'fast result'),
          executionMode: 'parallel',
        },
      ],
      new FakeApproval(true)
    );
    const model = new FakeModelTransport(async (_request, index) =>
      events(
        ...(index === 0
          ? [...toolCall('call_slow', 'slow', {}), ...toolCall('call_fast', 'fast', {})]
          : text('finished'))
      )
    );
    const loop = new AgentLoop({
      model,
      tools,
      ids: new SequentialIdGenerator(),
    });
    const eventsSeen: AgentLoopEvent[] = [];
    const result = await loop.run({
      sessionId: 'session_1',
      taskId: 'task_1',
      messages: [{ role: 'user', content: 'run tools' }],
      signal: new AbortController().signal,
      onEvent: (event) => {
        eventsSeen.push(event);
        if (event.type === 'tool_execution_start') starts.push(event.result.callId);
        if (event.type === 'tool_execution_end') ends.push(event.result.callId);
      },
    });

    expect(result.status).toBe('completed');
    expect(starts).toEqual(['call_slow', 'call_fast']);
    expect(ends).toEqual(['call_fast', 'call_slow']);
    const toolMessages = result.messages.filter((message) => message.role === 'tool');
    expect(toolMessages.map((message) => message.callId)).toEqual(['call_slow', 'call_fast']);
  });

  it('inserts a guide after the active model turn before a new turn starts', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const h = createTestWorkspace({
      model: async (request, index) => {
        if (index === 0) {
          await gate;
          return events(...text('first answer'));
        }
        expect(request.messages.at(-1)).toEqual({ role: 'user', content: 'steer this' });
        return events(...text('steered answer'));
      },
      tools: [],
    });

    await h.runtime.command(command('session_1', 'command_1', 'start'));
    await until(() => h.model.requests.length === 1);
    const guide = await h.runtime.command(
      command('session_1', 'command_guide', 'steer this', {
        payload: { text: 'steer this', delivery: 'guide' },
      })
    );
    expect(guide.status).toBe('accepted');
    release();
    await h.runtime.waitForSessionIdle('session_1');

    expect(h.model.requests).toHaveLength(2);
    expect(h.runtime.getProjection('session_1').rows.map((row) => row.text)).toEqual([
      'start',
      'Thinking complete',
      'first answer',
      'steer this',
      'Thinking complete',
      'steered answer',
    ]);
    expect(h.runtime.getSessionView('session_1')?.ledger.map((entry) => entry.delivery)).toEqual([
      'startNow',
      'guide',
    ]);
  });

  it('applies follow-up before natural completion of the run', async () => {
    const model = new FakeModelTransport(async (_request, index) =>
      events(...text(index === 0 ? 'initial' : 'followed'))
    );
    const loop = new AgentLoop({
      model,
      tools: new ToolExecutor([], new FakeApproval(true)),
      ids: new SequentialIdGenerator(),
    });
    loop.followUp('continue with this detail');
    const result = await loop.run({
      sessionId: 'session_1',
      taskId: 'task_1',
      messages: [{ role: 'user', content: 'start' }],
      signal: new AbortController().signal,
    });
    expect(result.status).toBe('completed');
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1].messages.at(-1)).toEqual({
      role: 'user',
      content: 'continue with this detail',
    });
  });

  it('recovers once from context overflow by compacting and retrying', async () => {
    const h = createTestWorkspace({
      model: async (_request, index) => {
        if (index === 0) return events(...text('history established'));
        if (index === 1) {
          return events({
            type: 'error',
            error: {
              code: 'MODEL_HTTP_400',
              message: 'maximum context length exceeded',
              retryable: false,
            },
          });
        }
        if (index === 2) return events(...text('summary of prior context'));
        return events(...text('recovered answer'));
      },
      tools: [],
    });
    await h.runtime.command(command('session_1', 'command_1', 'establish history'));
    await h.runtime.waitForSessionIdle('session_1');
    await h.runtime.command(command('session_1', 'command_2', 'trigger overflow'));
    await h.runtime.waitForSessionIdle('session_1');

    expect(h.runtime.getProjection('session_1')).toMatchObject({
      taskStatus: 'completed',
      rows: expect.arrayContaining([
        expect.objectContaining({ kind: 'assistant', text: 'recovered answer' }),
      ]),
    });
    expect(h.model.requests).toHaveLength(4);
    expect(
      h.model.requests.at(-1)?.messages.some(
        (message) =>
          message.role === 'user' && message.content.includes('Conversation summary')
      )
    ).toBe(true);
  });
});
