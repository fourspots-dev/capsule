import { describe, expect, it } from 'vitest';
import type { ProductProjection } from '../../src/core/types';
import { ProjectionExecutionTracker } from '../../src/observability/projection-execution-tracker';

describe('REQ-OBS-001 projection execution tracker', () => {
  it('emits user, reasoning, tool, child and assistant events', () => {
    const tracker = new ProjectionExecutionTracker();
    const first = tracker.observe(
      projection({
        revision: 1,
        rows: [
          row('user', 'user', 'Build a terminal'),
          row('reason', 'reasoning', 'Inspect the page', 'streaming'),
        ],
      })
    );
    expect(first.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['status', 'user', 'reasoning'])
    );
    const second = tracker.observe(
      projection({
        revision: 2,
        rows: [
          row('user', 'user', 'Build a terminal', 'completed'),
          row('reason', 'reasoning', 'Inspect the page first', 'completed'),
          row('tool', 'tool', 'page snapshot', 'streaming', 'call_1', 'snapshot'),
        ],
        children: [
          {
            taskId: 'child_1',
            sessionId: 'child_session',
            parentTaskId: 'task_1',
            profileName: 'general',
            status: 'running',
            executionMode: 'background',
            updatedAt: 10,
          },
        ],
      })
    );
    expect(second).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'reasoning',
          phase: 'completed',
          payload: expect.objectContaining({
            delta: ' first',
            text: 'Inspect the page first',
          }),
        }),
        expect.objectContaining({
          kind: 'tool',
          callId: 'call_1',
          actor: 'tool',
        }),
        expect.objectContaining({
          kind: 'child-agent',
          taskId: 'child_1',
          actor: 'child-agent',
        }),
      ])
    );
    expect(
      tracker.observe(
        projection({
          revision: 2,
          rows: [
            row('user', 'user', 'Build a terminal', 'completed'),
            row('reason', 'reasoning', 'Inspect the page first', 'completed'),
            row('tool', 'tool', 'page snapshot', 'streaming', 'call_1', 'snapshot'),
          ],
        })
      )
    ).toEqual([]);
  });

  it('stores only the append delta for streaming debug events', () => {
    const tracker = new ProjectionExecutionTracker();
    tracker.observe(
      projection({
        revision: 1,
        rows: [row('reason', 'reasoning', 'thinking', 'streaming')],
      })
    );
    const events = tracker.observeChange({
      type: 'delta',
      sessionId: 'session_1',
      logEpoch: 'epoch',
      baseRevision: 1,
      revision: 2,
      eventSeq: 2,
      deltas: [
        {
          type: 'row.delta',
          rowId: 'reason',
          path: 'text',
          append: ' more',
        },
      ],
    });
    expect(events).toEqual([
      expect.objectContaining({
        kind: 'reasoning',
        visibility: 'displayed-reasoning',
        payload: {
          rowId: 'reason',
          delta: ' more',
          textLength: 13,
          status: 'streaming',
        },
      }),
    ]);
    expect(events[0].payload).not.toHaveProperty('text');
  });
});

function projection(
  overrides: Partial<ProductProjection> = {}
): ProductProjection {
  return {
    sessionId: 'session_1',
    revision: 0,
    eventSeq: 1,
    logEpoch: 'epoch',
    phase: 'running',
    lifecycle: 'ready',
    taskStatus: 'running',
    activeTaskId: 'task_1',
    inputRouting: 'queue',
    queueLength: 0,
    permissionMode: 'build',
    availability: {
      canSend: true,
      canStop: true,
      canApprove: false,
      canQueue: true,
    },
    rows: [],
    ...overrides,
  };
}

function row(
  id: string,
  kind: 'user' | 'reasoning' | 'tool',
  text: string,
  status: 'pending' | 'streaming' | 'completed' = 'completed',
  callId?: string,
  toolName?: string
): ProductProjection['rows'][number] {
  return {
    id,
    entityId: id,
    productTurnId: 'task_1',
    kind,
    text,
    status,
    ...(callId ? { callId } : {}),
    ...(toolName ? { toolName } : {}),
  };
}
