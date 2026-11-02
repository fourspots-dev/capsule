import { describe, expect, it } from 'vitest';
import type { ExecutionEventInput } from '../../src/observability/execution-event';
import { ExecutionEventHub } from '../../src/observability/execution-hub';

describe('REQ-OBS-001 execution event hub', () => {
  it('deduplicates, paginates with cursors and redacts before storage', async () => {
    const hub = new ExecutionEventHub({ epoch: 'epoch_test', maxEvents: 10 });
    const first = await hub.ingest([
      event('client_1', 1, { text: 'Bearer secret-token' }),
      event('client_2', 2),
    ]);
    expect(first.accepted).toHaveLength(2);
    expect(first.accepted[0].payload).toEqual({
      text: 'Bearer [REDACTED]',
    });
    expect(await hub.ingest([event('client_1', 1)])).toMatchObject({
      accepted: [],
      duplicates: 1,
    });

    const page = hub.query('session_1', undefined, 1);
    expect(page.events).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    const next = hub.query('session_1', page.nextCursor, 10);
    expect(next.events.map((item) => item.sequence)).toEqual([2]);
    expect(next.events[0].sequence).toBeGreaterThan(page.events[0].sequence);
  });

  it('marks retained cursor gaps and notifies live subscribers', async () => {
    const hub = new ExecutionEventHub({ epoch: 'epoch_test', maxEvents: 2 });
    await hub.ingest([event('client_1', 1), event('client_2', 2)]);
    const staleCursor = hub.query('session_1', undefined, 1).nextCursor;
    const live: number[] = [];
    const subscription = hub.subscribe(
      'session_1',
      (item) => live.push(item.sequence),
      hub.query('session_1', undefined, 2).nextCursor
    );
    await hub.ingest([event('client_3', 3), event('client_4', 4)]);
    expect(live).toEqual([3, 4]);
    expect(hub.query('session_1', staleCursor, 10).truncated).toBe(true);
    subscription.unsubscribe();
  });
});

function event(
  clientEventId: string,
  timestamp: number,
  payload: ExecutionEventInput['payload'] = { text: clientEventId }
): ExecutionEventInput {
  return {
    clientEventId,
    timestamp,
    sessionId: 'session_1',
    kind: 'reasoning',
    phase: 'updated',
    actor: 'agent',
    visibility: 'displayed-reasoning',
    payload,
  };
}
