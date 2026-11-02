import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from '../../src/core';
import { events, text } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

describe('REQ-PERF-001 session residency bounds', () => {
  it('evicts idle persisted sessions while keeping all history available', async () => {
    const store = new InMemorySessionStore();
    const workspace = createTestWorkspace({
      model: async () => events(...text('done'), {
        type: 'finish',
        reason: 'stop',
      }),
      tools: [],
      sessionStore: store,
      maxResidentSessions: 2,
    });
    for (const index of [1, 2, 3]) {
      const sessionId = `session_${index}`;
      await workspace.runtime.command(
        command(sessionId, `command_${index}`, `task ${index}`)
      );
      await workspace.runtime.waitForSessionIdle(sessionId);
      await workspace.runtime.flush(sessionId);
    }
    await workspace.runtime.ensureSessionReady('session_4');
    expect(workspace.runtime.getSessionView('session_1')).toBeUndefined();
    expect((await workspace.runtime.listSessions()).map((item) => item.sessionId)).toEqual(
      expect.arrayContaining(['session_1', 'session_2', 'session_3', 'session_4'])
    );
  });
});
