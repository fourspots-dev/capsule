import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  canTransitionLifecycle,
  canTransitionTask,
  isTerminalTaskStatus,
  type SessionLifecycleState,
  type TaskStatus,
} from '../../src/core';

const lifecycleStates: SessionLifecycleState[] = [
  'unloaded',
  'starting',
  'ready',
  'stopping',
  'faulted',
];

const taskStatuses: TaskStatus[] = [
  'queued',
  'running',
  'waiting',
  'paused',
  'completed',
  'failed',
  'cancelled',
];

describe('state machine properties', () => {
  it('never leaves completed, failed, or cancelled task states', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<TaskStatus>('completed', 'failed', 'cancelled'),
        fc.constantFrom(...taskStatuses),
        (terminal, target) => {
          expect(isTerminalTaskStatus(terminal)).toBe(true);
          expect(canTransitionTask(terminal, target)).toBe(false);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never leaves the faulted lifecycle without an explicit replacement', () => {
    fc.assert(
      fc.property(fc.constantFrom(...lifecycleStates), (target) => {
        expect(canTransitionLifecycle('faulted', target)).toBe(false);
      }),
      { numRuns: 100 }
    );
  });

  it('only treats precisely the three declared task states as terminal', () => {
    fc.assert(
      fc.property(fc.constantFrom(...taskStatuses), (status) => {
        const expected = status === 'completed' || status === 'failed' || status === 'cancelled';
        expect(isTerminalTaskStatus(status)).toBe(expected);
      }),
      { numRuns: 100 }
    );
  });
});
