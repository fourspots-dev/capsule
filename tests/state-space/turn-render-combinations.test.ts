import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  ConversationRow,
  ProductProjection,
} from '../../src/core/types';
import { buildTurnRenderUnits } from '../../src/sidepanel/turn-render-model';

const rowKinds = ['reasoning', 'tool', 'activity', 'plan'] as const;
const statuses = [
  'pending',
  'streaming',
  'completed',
  'failed',
  'denied',
  'cancelled',
] as const;
const taskStatuses = [
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;

describe('Projection to render-model state combinations', () => {
  it('partitions every row once and keeps the final answer outside work history', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...rowKinds),
            status: fc.constantFrom(...statuses),
            text: fc.string({ maxLength: 20 }),
          }),
          { maxLength: 10 }
        ),
        fc.constantFrom(...taskStatuses),
        (middle, taskStatus) => {
          const rows: ConversationRow[] = [
            row('u1', 'user', 'request', 'completed'),
            ...middle.map((item, index) =>
              row(
                `m${index}`,
                item.kind,
                item.text,
                item.status,
                item.kind === 'tool'
                  ? { toolName: index % 2 ? 'exec' : 'read_page' }
                  : {}
              )
            ),
            row('a1', 'assistant', 'final answer', 'completed'),
          ];
          const [unit] = buildTurnRenderUnits(projection(rows, taskStatus));
          const [segment] = unit.segments;
          const partitioned = [
            ...(segment.user ? [segment.user.id] : []),
            ...segment.historyRows.map((item) => item.id),
            ...(segment.latestAssistant ? [segment.latestAssistant.id] : []),
            ...segment.tailRows.map((item) => item.id),
          ];

          expect(partitioned.sort()).toEqual(rows.map((item) => item.id).sort());
          expect(new Set(partitioned).size).toBe(partitioned.length);
          expect(segment.latestAssistant?.id).toBe('a1');
          expect(segment.historyRows.some((item) => item.id === 'a1')).toBe(false);
          expect(segment.tailRows.some((item) => item.id === 'a1')).toBe(false);
          if (taskStatus === 'failed' || taskStatus === 'cancelled') {
            expect(segment.defaultOpen).toBe(true);
          }
        }
      ),
      {
        numRuns: process.env.STATE_SPACE_DEEP === '1' ? 500 : 100,
        interruptAfterTimeLimit: 10_000,
      }
    );
  });
});

function row(
  id: string,
  kind: ConversationRow['kind'],
  text: string,
  status: ConversationRow['status'],
  extra: Partial<ConversationRow> = {}
): ConversationRow {
  return {
    id,
    entityId: id,
    productTurnId: 'task_1',
    kind,
    text,
    status,
    ...extra,
  };
}

function projection(
  rows: ConversationRow[],
  taskStatus: ProductProjection['taskStatus']
): ProductProjection {
  return {
    sessionId: 'state-test',
    revision: 1,
    eventSeq: 1,
    logEpoch: 'epoch',
    phase:
      taskStatus === 'failed'
        ? 'error'
        : taskStatus === 'running'
          ? 'running'
          : taskStatus === 'waiting'
            ? 'waiting'
            : 'completed',
    lifecycle: 'ready',
    taskStatus,
    inputRouting: 'startNow',
    queueLength: 0,
    activeTaskId: 'task_1',
    permissionMode: 'build',
    rows,
    availability: {
      canSend: true,
      canStop: true,
      canApprove: false,
      canQueue: true,
    },
  };
}
