import { describe, expect, it } from 'vitest';
import { EventLog } from '../../src/core/event-log';

describe('REQ-PERF-001 event log retention', () => {
  it('keeps sequence monotonic while bounding retained events', () => {
    const log = new EventLog('epoch', () => 1, 3);
    for (let index = 0; index < 5; index += 1) {
      log.append(`event_${index}`, index + 1);
    }
    expect(log.list().map((event) => event.seq)).toEqual([3, 4, 5]);
    expect(log.seq).toBe(5);
    expect(log.append('next', 6).seq).toBe(6);
  });
});
