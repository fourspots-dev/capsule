import { AgentError } from './errors';
import { isTerminalInputStatus } from './state-machines';
import type { InputDelivery, InputLedgerEntry } from './types';

export interface AdmitInput {
  inputId: string;
  sourceCommandId: string;
  text: string;
  delivery: InputDelivery;
  admittedAt: number;
}

export class InputLedger {
  private readonly entries = new Map<string, InputLedgerEntry>();

  admit(input: AdmitInput): InputLedgerEntry {
    if (this.entries.has(input.inputId)) {
      throw new AgentError('INPUT_DUPLICATE', `Input already exists: ${input.inputId}`);
    }
    const entry: InputLedgerEntry = { ...input, status: 'admitted' };
    this.entries.set(entry.inputId, entry);
    return { ...entry };
  }

  promote(inputId: string): InputLedgerEntry {
    return this.terminate(inputId, 'admitted', 'promoted');
  }

  cancel(inputId: string, reason = 'cancelled'): InputLedgerEntry {
    return this.terminate(inputId, 'admitted', 'cancelled', reason);
  }

  discard(inputId: string, reason = 'session_resumed'): InputLedgerEntry {
    return this.terminate(inputId, 'admitted', 'discarded', reason);
  }

  fail(inputId: string, reason: string): InputLedgerEntry {
    return this.terminate(inputId, 'admitted', 'failed', reason);
  }

  get(inputId: string): InputLedgerEntry | undefined {
    const entry = this.entries.get(inputId);
    return entry ? { ...entry } : undefined;
  }

  list(): InputLedgerEntry[] {
    return [...this.entries.values()].map((entry) => ({ ...entry }));
  }

  restore(entries: readonly InputLedgerEntry[]): void {
    this.entries.clear();
    for (const entry of entries) this.entries.set(entry.inputId, { ...entry });
  }

  private terminate(
    inputId: string,
    expected: 'admitted',
    next: 'promoted' | 'cancelled' | 'discarded' | 'failed',
    reason?: string
  ): InputLedgerEntry {
    const entry = this.entries.get(inputId);
    if (!entry) throw new AgentError('INPUT_NOT_FOUND', `Input not found: ${inputId}`);
    if (entry.status !== expected) {
      throw new AgentError(
        'INPUT_TRANSITION_INVALID',
        `Input ${inputId} cannot transition from ${entry.status} to ${next}`,
        { details: { inputId, current: entry.status, next } }
      );
    }
    const updated: InputLedgerEntry = {
      ...entry,
      status: next,
      ...(reason === undefined ? {} : { terminalReason: reason }),
    };
    this.entries.set(inputId, updated);
    return { ...updated };
  }
}

export function assertTerminalLedgerSnapshot(entries: readonly InputLedgerEntry[]): void {
  for (const entry of entries) {
    if (!isTerminalInputStatus(entry.status)) {
      throw new AgentError('INPUT_NOT_TERMINAL', `Input is still ${entry.status}: ${entry.inputId}`);
    }
  }
}
