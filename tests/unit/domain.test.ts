import { describe, expect, it } from 'vitest';
import {
  InputLedger,
  SequentialIdGenerator,
  canTransitionLifecycle,
  canTransitionTask,
  isTerminalInputStatus,
} from '../../src/core';

describe('SequentialIdGenerator', () => {
  it('reserves numeric sequences from restored ids', () => {
    const ids = new SequentialIdGenerator();
    ids.reserve(['task_7', 'input_3', 'row_9', 'message_12']);

    expect(ids.next('task')).toBe('task_8');
    expect(ids.next('input')).toBe('input_4');
    expect(ids.next('row')).toBe('row_10');
    expect(ids.next('message')).toBe('message_13');
  });
});

describe('state machines', () => {
  it('keeps lifecycle and task status as independent machines', () => {
    expect(canTransitionLifecycle('unloaded', 'starting')).toBe(true);
    expect(canTransitionLifecycle('ready', 'starting')).toBe(false);
    expect(canTransitionLifecycle('faulted', 'ready')).toBe(false);

    expect(canTransitionTask('queued', 'running')).toBe(true);
    expect(canTransitionTask('running', 'waiting')).toBe(true);
    expect(canTransitionTask('running', 'cancelled')).toBe(true);
    expect(canTransitionTask('completed', 'running')).toBe(false);
  });
});

describe('InputLedger', () => {
  it('persists admitted input through a single terminal transition', () => {
    const ledger = new InputLedger();
    const admitted = ledger.admit({
      inputId: 'input_1',
      sourceCommandId: 'command_1',
      text: 'inspect',
      delivery: 'startNow',
      admittedAt: 10,
    });

    expect(admitted.status).toBe('admitted');
    expect(isTerminalInputStatus(admitted.status)).toBe(false);
    expect(ledger.promote('input_1').status).toBe('promoted');
    expect(isTerminalInputStatus(ledger.get('input_1')!.status)).toBe(true);
    expect(() => ledger.cancel('input_1')).toThrowError(/cannot transition from promoted/);
  });

  it('does not silently reuse an input id', () => {
    const ledger = new InputLedger();
    const input = {
      inputId: 'input_1',
      sourceCommandId: 'command_1',
      text: 'inspect',
      delivery: 'queue' as const,
      admittedAt: 10,
    };
    ledger.admit(input);
    expect(() => ledger.admit(input)).toThrowError(/already exists/);
  });

  it('discards admitted work after a restart instead of replaying it', () => {
    const ledger = new InputLedger();
    ledger.admit({
      inputId: 'input_1',
      sourceCommandId: 'command_1',
      text: 'unfinished',
      delivery: 'startNow',
      admittedAt: 10,
    });
    expect(ledger.discard('input_1', 'session_resumed')).toMatchObject({
      status: 'discarded',
      terminalReason: 'session_resumed',
    });
  });
});
