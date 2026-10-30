import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  InputLedger,
  isTerminalInputStatus,
  type InputDelivery,
  type InputLedgerStatus,
} from '../../src/core';

type TerminalOperation = 'promote' | 'cancel' | 'discard' | 'fail';

const terminalOperations: TerminalOperation[] = ['promote', 'cancel', 'discard', 'fail'];
const deliveries: InputDelivery[] = ['startNow', 'guide', 'queue'];

const expectedStatus: Record<TerminalOperation, InputLedgerStatus> = {
  promote: 'promoted',
  cancel: 'cancelled',
  discard: 'discarded',
  fail: 'failed',
};

function terminate(ledger: InputLedger, inputId: string, operation: TerminalOperation): void {
  if (operation === 'fail') {
    ledger.fail(inputId, 'test_failure');
    return;
  }
  ledger[operation](inputId, 'test_reason');
}

describe('InputLedger properties', () => {
  it('keeps any admitted input at one terminal state after its first terminal operation', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 80 }),
        fc.constantFrom(...deliveries),
        fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }),
        fc.constantFrom(...terminalOperations),
        fc.array(fc.constantFrom(...terminalOperations), { minLength: 1, maxLength: 12 }),
        (text, delivery, admittedAt, firstOperation, laterOperations) => {
          const ledger = new InputLedger();
          ledger.admit({
            inputId: 'input_1',
            sourceCommandId: 'command_1',
            text,
            delivery,
            admittedAt,
          });

          terminate(ledger, 'input_1', firstOperation);
          const terminal = ledger.get('input_1')!;
          expect(terminal.status).toBe(expectedStatus[firstOperation]);
          expect(isTerminalInputStatus(terminal.status)).toBe(true);

          for (const operation of laterOperations) {
            expect(() => terminate(ledger, 'input_1', operation)).toThrowError(
              /cannot transition from (promoted|cancelled|discarded|failed)/
            );
            expect(ledger.get('input_1')).toEqual(terminal);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('never overwrites an existing input id, even after it reached a terminal state', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.constantFrom(...terminalOperations),
        (inputId, operation) => {
          const ledger = new InputLedger();
          const input = {
            inputId,
            sourceCommandId: 'command_1',
            text: 'original',
            delivery: 'startNow' as const,
            admittedAt: 1,
          };
          ledger.admit(input);
          terminate(ledger, inputId, operation);
          const before = ledger.get(inputId);

          expect(() =>
            ledger.admit({
              ...input,
              sourceCommandId: 'command_2',
              text: 'replacement',
            })
          ).toThrowError(/already exists/);
          expect(ledger.get(inputId)).toEqual(before);
        }
      ),
      { numRuns: 100 }
    );
  });
});
