import { describe, expect, it } from 'vitest';
import type { ProductProjection } from '../../src/core';
import {
  applyProjectionFrame,
  createProjectionFrame,
} from '../../src/core/projection';

function projection(revision: number): ProductProjection {
  return {
    sessionId: 'session_1',
    revision,
    eventSeq: revision,
    logEpoch: 'epoch_1',
    phase: revision === 1 ? 'running' : 'completed',
    lifecycle: 'ready',
    taskStatus: revision === 1 ? 'running' : 'completed',
    inputRouting: revision === 1 ? 'queue' : 'startNow',
    queueLength: revision === 1 ? 1 : 0,
    permissionMode: 'guarded',
    rows: [
      {
        id: 'row_1',
        entityId: 'entity_1',
        productTurnId: 'turn_1',
        kind: 'assistant',
        text: revision === 1 ? 'hel' : 'hello',
        status: revision === 1 ? 'streaming' : 'completed',
      },
    ],
    availability: {
      canSend: true,
      canStop: revision === 1,
      canApprove: false,
      canQueue: revision === 1,
    },
  };
}

describe('projection protocol', () => {
  it('emits only closed state and row deltas', () => {
    const frame = createProjectionFrame(projection(1), projection(2));
    expect(frame.type).toBe('delta');
    if (frame.type !== 'delta') throw new Error('expected delta');
    expect(frame).toMatchObject({
      baseRevision: 1,
      revision: 2,
      eventSeq: 2,
    });
    expect(frame.deltas).toEqual([
      {
        type: 'state.updated',
        patch: expect.objectContaining({ phase: 'completed', queueLength: 0 }),
      },
      {
        type: 'row.upserted',
        row: expect.objectContaining({ id: 'row_1', text: 'hello', status: 'completed' }),
      },
    ]);
  });

  it('reconstructs exactly the same projection as a snapshot', () => {
    const before = projection(1);
    const after = projection(2);
    const frame = createProjectionFrame(before, after);
    expect(applyProjectionFrame(before, frame)).toEqual(after);
  });

  it('rejects gaps and epoch changes instead of deep-merging uncertain state', () => {
    const before = projection(1);
    const after = projection(2);
    const frame = createProjectionFrame(before, after);
    expect(() => applyProjectionFrame(projection(0), frame)).toThrowError(/Projection frame gap/);

    const reset = { ...projection(3), logEpoch: 'epoch_2' };
    expect(createProjectionFrame(after, reset)).toEqual({
      type: 'snapshot',
      projection: reset,
    });
  });
});
