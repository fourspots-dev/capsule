import { describe, expect, it } from 'vitest';
import { applyProjectionDelta } from '../../src/core';
import {
  FakeApproval,
  abortError,
  events,
  readTool,
  text,
  toolCall,
  until,
  writeTool,
} from '../harness/fakes';
import { command, createTestWorkspace, stopCommand } from '../harness/workspace';

describe('headless WorkspaceRuntime', () => {
  it('projects provider reasoning separately from the visible answer', async () => {
    const h = createTestWorkspace({
      model: async () =>
        events(
          { type: 'reasoning_delta', text: 'Inspect the request.' },
          ...text('Here is the answer.')
        ),
      tools: [],
    });

    await h.runtime.command(command('session_1', 'command_reasoning', 'Explain it'));
    await h.runtime.waitForSessionIdle('session_1');

    const projection = h.runtime.getProjection('session_1');
    expect(projection.rows.map((row) => row.kind)).toEqual([
      'user',
      'activity',
      'reasoning',
      'assistant',
    ]);
    expect(projection.rows.map((row) => row.text)).toEqual([
      'Explain it',
      'Thinking complete',
      'Inspect the request.',
      'Here is the answer.',
    ]);
    expect(projection.rows.find((row) => row.kind === 'activity')).toMatchObject({
      startedAt: expect.any(Number),
      completedAt: expect.any(Number),
    });
  });

  it('runs a deterministic tool loop and produces a command-driven projection', async () => {
    let effects = 0;
    const h = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? toolCall('call_1', 'read', { text: 'hello' })
            : text('The page says hello.'))
        ),
      tools: [
        readTool('read', async () => {
          effects += 1;
          return 'hello from fake page';
        }),
      ],
      systemPrompt: 'You are a test agent.',
    });

    h.runtime.getSessionView('session_1');
    expect(h.runtime.getSessionView('session_1')).toBeUndefined();

    const ack = await h.runtime.command(command('session_1', 'command_1', 'Read the page'));
    expect(ack).toMatchObject({ status: 'accepted', inputId: 'input_1' });

    await h.runtime.waitForSessionIdle('session_1');
    expect(h.runtime.queryCommand('session_1', 'command_1')).toMatchObject({
      status: 'accepted',
      inputId: 'input_1',
    });
    const projection = h.runtime.getProjection('session_1');
    const view = h.runtime.getSessionView('session_1');

    expect(projection.lastError).toBeUndefined();
    expect(projection).toMatchObject({
      sessionId: 'session_1',
      lifecycle: 'ready',
      taskStatus: 'completed',
      phase: 'completed',
      queueLength: 0,
      availability: {
        canSend: true,
        canStop: false,
        canApprove: false,
        canQueue: false,
      },
    });
    expect(projection.rows.map((row) => row.kind)).toEqual([
      'user',
      'activity',
      'assistant',
      'tool',
      'activity',
      'assistant',
    ]);
    expect(projection.rows.map((row) => row.text)).toEqual([
      'Read the page',
      'Thinking complete',
      '',
      'hello from fake page',
      'Thinking complete',
      'The page says hello.',
    ]);
    expect(view?.ledger).toEqual([
      expect.objectContaining({ sourceCommandId: 'command_1', status: 'promoted' }),
    ]);
    expect(effects).toBe(1);
    expect(h.model.requests).toHaveLength(2);
    expect(h.model.requests[0].messages[0]).toEqual({
      role: 'system',
      content: 'You are a test agent.',
    });

    const runtimeEvents = h.runtime.eventLog('session_1');
    expect(runtimeEvents.length).toBe(projection.eventSeq);
    expect(runtimeEvents.map((event) => event.seq)).toEqual(
      Array.from({ length: runtimeEvents.length }, (_, index) => index + 1)
    );
    expect(runtimeEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining(['input.admitted', 'task.started', 'tool.finished', 'task.finished'])
    );
  });

  it('does not create a session merely by reading its state', () => {
    const h = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    expect(h.runtime.getSessionView('missing')).toBeUndefined();
    expect(() => h.runtime.getProjection('missing')).toThrowError(/Session not found/);
  });

  it('deduplicates a command id before it can create a second task or side effect', async () => {
    let effects = 0;
    const h = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? toolCall('call_1', 'read', { text: 'once' })
            : text('finished'))
        ),
      tools: [
        readTool('read', async () => {
          effects += 1;
          return 'once';
        }),
      ],
    });
    const duplicateCommand = command('session_1', 'same-command', 'work');
    const [first, duplicate] = await Promise.all([
      h.runtime.command(duplicateCommand),
      h.runtime.command(duplicateCommand),
    ]);
    await h.runtime.waitForSessionIdle('session_1');

    expect(first.status).toBe('accepted');
    expect(duplicate.status).toBe('duplicate');
    expect(effects).toBe(1);
    expect(h.runtime.getProjection('session_1').rows.filter((row) => row.kind === 'user')).toHaveLength(1);
  });

  it('rejects stale commands without replaying them', async () => {
    const h = createTestWorkspace({
      model: async () => events(...text('done')),
      tools: [],
    });
    await h.runtime.command(command('session_1', 'command_1', 'first'));
    await h.runtime.waitForSessionIdle('session_1');

    const ack = await h.runtime.command(
      command('session_1', 'command_2', 'stale', { baseRevision: 0 })
    );
    expect(ack).toMatchObject({
      status: 'stale',
      error: { code: 'COMMAND_STALE' },
    });
    expect(h.runtime.getProjection('session_1').rows).toHaveLength(3);
  });

  it('rejects empty input', async () => {
    const h = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    const ack = await h.runtime.command(command('session_1', 'command_1', '   '));
    expect(ack).toMatchObject({ status: 'rejected', error: { code: 'INPUT_EMPTY' } });
    expect(h.runtime.getSessionView('session_1')?.rows).toHaveLength(0);
  });

  it('keeps display input separate from skill and attachment model context', async () => {
    const h = createTestWorkspace({
      model: async () => events(...text('context received')),
      tools: [],
    });
    await h.runtime.command({
      ...command('session_1', 'command_1', 'inspect this'),
      payload: {
        text: 'inspect this',
        context: {
          skill: { name: 'review', instructions: 'Review every claim.' },
          attachments: [{ name: 'notes.txt', type: 'text/plain', text: 'source evidence' }],
        },
      },
    });
    await h.runtime.waitForSessionIdle('session_1');
    const content = h.model.requests[0].messages.at(-1)?.content;
    expect(content).toContain('Review every claim.');
    expect(content).toContain('source evidence');
    expect(h.runtime.getProjection('session_1').rows[0].text).toBe('inspect this');
  });

  it('turns malformed tool arguments into an explicit tool failure', async () => {
    const h = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? [
                {
                  type: 'tool_call' as const,
                  call: { id: 'call_bad', name: 'read', arguments: '"not an object"' },
                },
                { type: 'finish' as const, reason: 'tool_calls' },
              ]
            : text('Recovered after the tool error.'))
        ),
      tools: [readTool()],
    });
    await h.runtime.command(command('session_1', 'command_1', 'try bad args'));
    await h.runtime.waitForSessionIdle('session_1');

    const toolRow = h.runtime
      .getProjection('session_1')
      .rows.find((row) => row.kind === 'tool');
    expect(toolRow).toMatchObject({
      status: 'failed',
      text: 'Tool arguments must be a JSON object',
    });
    expect(h.runtime.getProjection('session_1').phase).toBe('completed');
  });

  it('records an approval denial and lets the agent observe it', async () => {
    const approval = new FakeApproval(false);
    const h = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? toolCall('call_write', 'write', {})
            : text('The write was denied.'))
        ),
      tools: [writeTool()],
      approval,
    });
    await h.runtime.command(command('session_1', 'command_1', 'write a file'));
    await h.runtime.waitForSessionIdle('session_1');

    expect(approval.requests).toHaveLength(1);
    expect(
      h.runtime.getProjection('session_1').rows.find((row) => row.kind === 'tool')
    ).toMatchObject({
      status: 'denied',
      text: 'User denied write',
    });
  });

  it('marks a timed-out tool as failed and aborts the execution signal', async () => {
    let observedAbort = false;
    const hangingTool = readTool('hang');
    hangingTool.timeoutMs = 5;
    hangingTool.execute = async (_input, invocation) =>
      new Promise<never>((_resolve, reject) => {
        invocation.signal.addEventListener(
          'abort',
          () => {
            observedAbort = true;
            reject(new Error('aborted'));
          },
          { once: true }
        );
      });
    const h = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? toolCall('call_hang', 'hang', {})
            : text('Observed the timeout.'))
        ),
      tools: [hangingTool],
    });

    await h.runtime.command(command('session_1', 'command_1', 'timeout'));
    await h.runtime.waitForSessionIdle('session_1');
    expect(observedAbort).toBe(true);
    expect(
      h.runtime.getProjection('session_1').rows.find((row) => row.kind === 'tool')
    ).toMatchObject({
      status: 'failed',
      text: 'Tool timed out after 5ms',
    });
  });

  it('queues input while a turn is running and preserves source order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const h = createTestWorkspace({
      model: async (_request, index) => {
        if (index === 0) await firstGate;
        return events(...text(index === 0 ? 'first done' : 'second done'));
      },
      tools: [],
    });

    await h.runtime.command(command('session_1', 'command_1', 'first'));
    await until(() => h.model.requests.length === 1);
    const queuedAck = await h.runtime.command(command('session_1', 'command_2', 'second'));
    expect(queuedAck.status).toBe('accepted');
    expect(h.runtime.getProjection('session_1')).toMatchObject({
      inputRouting: 'queue',
      queueLength: 1,
      availability: { canQueue: true },
    });

    releaseFirst();
    await h.runtime.waitForSessionIdle('session_1');
    const projection = h.runtime.getProjection('session_1');
    expect(projection.rows.filter((row) => row.kind === 'user').map((row) => row.text)).toEqual([
      'first',
      'second',
    ]);
    expect(projection.rows.filter((row) => row.kind === 'assistant').map((row) => row.text)).toEqual([
      'first done',
      'second done',
    ]);
    expect(h.runtime.getSessionView('session_1')?.ledger.map((entry) => entry.status)).toEqual([
      'promoted',
      'promoted',
    ]);
  });

  it('propagates stop through the active model request', async () => {
    const h = createTestWorkspace({
      model: async (request) => {
        await new Promise<void>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(abortError()), { once: true });
        });
        return events();
      },
      tools: [],
    });

    await h.runtime.command(command('session_1', 'command_1', 'wait forever'));
    await until(() => h.model.requests.length === 1);
    const stopAck = await h.runtime.command(stopCommand('session_1', 'stop_1'));
    expect(stopAck.status).toBe('accepted');
    await h.runtime.waitForSessionIdle('session_1');

    expect(h.runtime.getProjection('session_1')).toMatchObject({
      taskStatus: 'cancelled',
      phase: 'completed',
      availability: { canStop: false },
    });
    expect(
      h.runtime.getProjection('session_1').rows.find((row) => row.kind === 'assistant')?.status
    ).toBe('cancelled');
  });

  it('applies only closed projection deltas deterministically', () => {
    const h = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
    });
    void h;
    const projection = {
      sessionId: 'session_1',
      revision: 1,
      eventSeq: 1,
      logEpoch: 'epoch_1',
      phase: 'draft' as const,
      lifecycle: 'ready' as const,
      taskStatus: 'completed' as const,
      inputRouting: 'startNow' as const,
      queueLength: 0,
      permissionMode: 'guarded' as const,
      rows: [],
      availability: { canSend: true, canStop: false, canApprove: false, canQueue: false },
    };
    const withRow = applyProjectionDelta(projection, {
      type: 'row.appended',
      row: {
        id: 'row_1',
        entityId: 'entity_1',
        productTurnId: 'turn_1',
        kind: 'assistant',
        text: 'hel',
        status: 'streaming',
      },
    });
    const streamed = applyProjectionDelta(withRow, {
      type: 'row.delta',
      rowId: 'row_1',
      path: 'text',
      append: 'lo',
    });
    expect(streamed.rows[0].text).toBe('hello');
  });

  it('persists plan mode and requires plan approval before build mode', async () => {
    const h = createTestWorkspace({
      model: async () => events(...text('initial')),
      tools: [],
    });
    await h.runtime.command(command('session_1', 'command_1', 'start'));
    await h.runtime.waitForSessionIdle('session_1');

    const planMode = await h.runtime.command({
      ...command('session_1', 'command_mode_plan', ''),
      type: 'set_mode',
      payload: { mode: 'plan' },
    });
    expect(planMode.status).toBe('accepted');
    const prematureBuild = await h.runtime.command({
      ...command('session_1', 'command_build_early', ''),
      type: 'set_mode',
      payload: { mode: 'build' },
    });
    expect(prematureBuild).toMatchObject({
      status: 'rejected',
      error: { code: 'PLAN_NOT_APPROVED' },
    });
    await h.runtime.command({
      ...command('session_1', 'command_plan', ''),
      type: 'submit_plan',
      payload: { plan: '1. inspect\n2. verify' },
    });
    await h.runtime.command({
      ...command('session_1', 'command_approve', ''),
      type: 'approve_plan',
      payload: {},
    });
    await h.runtime.command({
      ...command('session_1', 'command_build', ''),
      type: 'set_mode',
      payload: { mode: 'build' },
    });

    expect(h.runtime.getProjection('session_1')).toMatchObject({
      permissionMode: 'build',
      plan: {
        text: '1. inspect\n2. verify',
        approvedAt: h.clock.now(),
      },
    });
  });

  it('compacts model context while retaining the full product history', async () => {
    const h = createTestWorkspace({
      model: async (_request, index) => events(...text(`answer ${index}`)),
      tools: [],
    });
    await h.runtime.command(command('session_1', 'command_1', 'first question'));
    await h.runtime.waitForSessionIdle('session_1');
    await h.runtime.command(command('session_1', 'command_2', 'second question'));
    await h.runtime.waitForSessionIdle('session_1');

    const compact = await h.runtime.command({
      ...command('session_1', 'command_compact', ''),
      type: 'compact',
      payload: {
        summary: 'The user asked two questions and received two answers.',
        budget: {
          contextWindow: 100,
          reserveTokens: 10,
          keepRecentTokens: 1,
          maxOutputTokens: 10,
        },
      },
    });
    expect(compact.status).toBe('accepted');
    const rowsBefore = h.runtime.getProjection('session_1').rows.map((row) => row.text);
    expect(rowsBefore).toEqual([
      'first question',
      'Thinking complete',
      'answer 0',
      'second question',
      'Thinking complete',
      'answer 1',
      'Context compacted',
    ]);

    await h.runtime.command(command('session_1', 'command_3', 'third question'));
    await h.runtime.waitForSessionIdle('session_1');
    const nextRequest = h.model.requests.at(-1)!;
    expect(
      nextRequest.messages.some(
        (message) =>
          message.content.includes('Conversation summary') &&
          message.content.includes('two questions')
      )
    ).toBe(true);
    expect(h.runtime.getProjection('session_1').rows.length).toBeGreaterThan(rowsBefore.length);
  });
});
