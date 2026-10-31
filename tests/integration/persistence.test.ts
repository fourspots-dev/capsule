import { describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  type SessionSnapshot,
} from '../../src/core';
import { events, text } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

describe('session persistence and cold hydration', () => {
  it('persists the command input before ACK and reconstructs the same conversation', async () => {
    const store = new InMemorySessionStore();
    const first = createTestWorkspace({
      model: async () => events(...text('persisted answer')),
      tools: [],
      sessionStore: store,
    });
    const ack = await first.runtime.command(command('session_1', 'command_1', 'persist me'));
    expect(ack.status).toBe('accepted');
    await first.runtime.waitForSessionIdle('session_1');
    await first.runtime.flush('session_1');

    const stored = await store.load('session_1');
    expect(stored?.ledger).toEqual([
      expect.objectContaining({ sourceCommandId: 'command_1', status: 'promoted' }),
    ]);
    expect(stored?.commands).toEqual([
      expect.objectContaining({ commandId: 'command_1', status: 'accepted' }),
    ]);
    expect(stored?.rows.map((row) => row.text)).toEqual([
      'persist me',
      'Thinking complete',
      'persisted answer',
    ]);

    const second = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
      sessionStore: store,
    });
    const hydrated = await second.runtime.hydrateSession('session_1');
    expect(hydrated).toMatchObject({
      sessionId: 'session_1',
      lifecycle: 'unloaded',
      taskStatus: 'completed',
    });
    expect(hydrated?.rows.map((row) => row.text)).toEqual([
      'persist me',
      'Thinking complete',
      'persisted answer',
    ]);
    expect(second.runtime.queryCommand('session_1', 'command_1')).toMatchObject({
      status: 'accepted',
      inputId: 'input_1',
    });
    expect(await second.runtime.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'session_1',
        title: 'persist me',
        taskStatus: 'completed',
      }),
    ]);
    expect(second.model.requests).toHaveLength(0);

    const duplicate = await second.runtime.command(
      command('session_1', 'command_1', 'persist me')
    );
    expect(duplicate.status).toBe('duplicate');
    expect(second.model.requests).toHaveLength(0);
    expect(second.runtime.getProjection('session_1').rows).toHaveLength(3);

    const continued = await second.runtime.command(
      command('session_1', 'command_2', 'continue after restart')
    );
    expect(continued).toMatchObject({ status: 'accepted', taskId: 'task_2' });
    await second.runtime.waitForSessionIdle('session_1');
    expect(second.model.requests).toHaveLength(1);
    expect(second.runtime.getProjection('session_1').rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          productTurnId: 'task_2',
          kind: 'user',
          text: 'continue after restart',
        }),
      ])
    );
  });

  it('reconciles unfinished work as terminal without replaying admitted input', async () => {
    const store = new InMemorySessionStore();
    const interrupted: SessionSnapshot = {
      schemaVersion: 1,
      sessionId: 'session_interrupted',
      logEpoch: 'epoch_existing',
      revision: 7,
      eventSeq: 3,
      taskStatus: 'running',
      messages: [{ role: 'user', content: 'unfinished task' }],
      rows: [
        {
          id: 'row_1',
          entityId: 'input_1',
          productTurnId: 'task_1',
          kind: 'user',
          text: 'unfinished task',
          status: 'pending',
        },
        {
          id: 'row_2',
          entityId: 'message_1',
          productTurnId: 'task_1',
          kind: 'assistant',
          text: 'partial',
          status: 'streaming',
        },
      ],
      ledger: [
        {
          inputId: 'input_1',
          sourceCommandId: 'command_1',
          status: 'admitted',
          delivery: 'startNow',
          text: 'unfinished task',
          admittedAt: 1,
        },
      ],
      events: [
        { seq: 1, type: 'input.admitted', revision: 1, occurredAt: 1 },
        { seq: 2, type: 'task.started', revision: 2, occurredAt: 2 },
        { seq: 3, type: 'message.started', revision: 3, occurredAt: 3 },
      ],
    };
    await store.save(interrupted);

    const h = createTestWorkspace({
      model: async () => events(...text('must not run')),
      tools: [],
      sessionStore: store,
    });
    const view = await h.runtime.hydrateSession('session_interrupted');

    expect(view).toMatchObject({
      taskStatus: 'cancelled',
      lifecycle: 'unloaded',
      ledger: [expect.objectContaining({ status: 'discarded', terminalReason: 'session_resumed' })],
    });
    expect(view?.rows.map((row) => row.status)).toEqual(['cancelled', 'cancelled']);
    expect(h.model.requests).toHaveLength(0);
    await h.runtime.flush('session_interrupted');
    expect((await store.load('session_interrupted'))?.events.map((event) => event.type)).toContain(
      'session.reconciled'
    );
  });

  it('retains approved plan and permission mode across cold hydration', async () => {
    const store = new InMemorySessionStore();
    const first = createTestWorkspace({
      model: async () => events(...text('planned')),
      tools: [],
      sessionStore: store,
    });
    await first.runtime.command(command('session_plan', 'command_1', 'plan this'));
    await first.runtime.waitForSessionIdle('session_plan');
    await first.runtime.command({
      ...command('session_plan', 'mode_plan', ''),
      type: 'set_mode',
      payload: { mode: 'plan' },
    });
    await first.runtime.command({
      ...command('session_plan', 'submit_plan', ''),
      type: 'submit_plan',
      payload: { plan: '1. inspect\n2. verify' },
    });
    await first.runtime.command({
      ...command('session_plan', 'approve_plan', ''),
      type: 'approve_plan',
      payload: {},
    });
    await first.runtime.command({
      ...command('session_plan', 'mode_build', ''),
      type: 'set_mode',
      payload: { mode: 'build' },
    });
    await first.runtime.flush('session_plan');

    const second = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
      sessionStore: store,
    });
    await second.runtime.hydrateSession('session_plan');
    await second.runtime.ensureSessionReady('session_plan');
    expect(second.runtime.getProjection('session_plan')).toMatchObject({
      permissionMode: 'build',
      plan: {
        text: '1. inspect\n2. verify',
      },
    });
  });

  it('clears every persisted and in-memory session for a clean reset', async () => {
    const store = new InMemorySessionStore();
    const h = createTestWorkspace({
      model: async () => events(...text('answer')),
      tools: [],
      sessionStore: store,
    });
    await h.runtime.command(command('session_a', 'command_a', 'A'));
    await h.runtime.waitForSessionIdle('session_a');
    await h.runtime.command(command('session_b', 'command_b', 'B'));
    await h.runtime.waitForSessionIdle('session_b');
    expect(await h.runtime.listSessions()).toHaveLength(2);

    expect(await h.runtime.deleteAllSessions()).toBe(2);
    expect(await h.runtime.listSessions()).toEqual([]);
    expect(() => h.runtime.getProjection('session_a')).toThrowError(/not found/i);
    expect(await store.load('session_b')).toBeUndefined();
  });
});
