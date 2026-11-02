import { describe, expect, it, vi } from 'vitest';
import { applyProjectionFrame } from '../../src/core/projection';
import type { SessionProjectionChange } from '../../src/core/session-runtime';
import { events, text } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

describe('REQ-PERF-001 projection delta stream', () => {
  it('streams row deltas without rebuilding full projection snapshots', async () => {
    const workspace = createTestWorkspace({
      model: async () => events(...text('hello'), { type: 'finish', reason: 'stop' }),
      tools: [],
    });
    const changes: SessionProjectionChange[] = [];
    await workspace.runtime.ensureSessionReady('session_delta');
    const sessionRuntime = (
      workspace.runtime as unknown as {
        sessions: Map<string, { projection(): unknown }>;
      }
    ).sessions.get('session_delta')!;
    const projectionSpy = vi.spyOn(sessionRuntime, 'projection');
    const subscription = await workspace.runtime.subscribeChanges(
      'session_delta',
      (change) => changes.push(change)
    );
    expect(subscription).toBeDefined();
    await workspace.runtime.command(
      command('session_delta', 'command_delta', 'stream this')
    );
    await workspace.runtime.waitForSessionIdle('session_delta');

    expect(changes.length).toBeGreaterThan(0);
    expect(
      changes.flatMap((change) => change.deltas).map((delta) => delta.type)
    ).toEqual(
      expect.arrayContaining([
        'row.appended',
        'row.delta',
        'state.updated',
      ])
    );
    expect(projectionSpy).toHaveBeenCalledTimes(1);
    let current = subscription!.initial;
    for (const change of changes) {
      current = applyProjectionFrame(current, change);
    }
    expect(current).toEqual(workspace.runtime.getProjection('session_delta'));
    subscription!.unsubscribe();
  });
});
