import { AgentError } from './errors';
import type { Clock } from './ports';
import { assertLifecycleTransition } from './state-machines';
import type { SessionLifecycleState, StructuredError } from './types';

export interface SessionLifecycleSnapshot {
  sessionId: string;
  state: SessionLifecycleState;
  generation: number;
  revision: number;
  activeOperation?: 'ensureReady' | 'stop' | 'restart';
  lastError?: StructuredError;
}

export class SessionLifecycleController {
  private snapshot: SessionLifecycleSnapshot;
  private operation?: Promise<void>;

  constructor(
    private readonly sessionId: string,
    private readonly clock: Clock,
    private readonly onChange?: (snapshot: SessionLifecycleSnapshot) => void
  ) {
    this.snapshot = {
      sessionId,
      state: 'unloaded',
      generation: 0,
      revision: 0,
    };
  }

  getState(): SessionLifecycleSnapshot {
    return { ...this.snapshot };
  }

  async ensureReady(open: () => Promise<void>): Promise<void> {
    if (this.snapshot.state === 'ready') return;
    if (this.snapshot.state === 'faulted') {
      throw new AgentError('SESSION_FAULTED', `Session is faulted: ${this.sessionId}`);
    }
    if (this.snapshot.state === 'starting' && this.operation) {
      await this.operation;
      return;
    }
    if (this.snapshot.state === 'stopping') {
      throw new AgentError('SESSION_STOPPING', `Session is stopping: ${this.sessionId}`);
    }

    this.operation = this.start(open);
    await this.operation;
  }

  async stop(close: () => Promise<void>): Promise<void> {
    if (this.snapshot.state === 'unloaded') return;
    if (this.snapshot.state === 'stopping' && this.operation) {
      await this.operation;
      return;
    }
    if (this.snapshot.state === 'starting' && this.operation) {
      try {
        await this.operation;
      } catch {
        // A failed start remains faulted and cannot be converted into a clean stop.
      }
    }
    if (this.snapshot.state !== 'ready') return;

    this.operation = this.stopReady(close);
    await this.operation;
  }

  async restart(close: () => Promise<void>, open: () => Promise<void>): Promise<void> {
    await this.stop(close);
    if (this.snapshot.state === 'faulted') {
      throw new AgentError('SESSION_RESTART_BLOCKED', 'Cannot restart a faulted session without recovery');
    }
    this.setOperation('restart');
    try {
      await this.ensureReady(open);
    } finally {
      this.clearOperation();
    }
  }

  private async start(open: () => Promise<void>): Promise<void> {
    this.transition('starting');
    this.setOperation('ensureReady');
    try {
      await open();
      if (this.snapshot.state !== 'starting') return;
      this.transition('ready');
      this.snapshot.generation += 1;
      this.emit();
    } catch (error) {
      this.fault('ensureReady', error);
      throw error;
    } finally {
      this.operation = undefined;
      this.clearOperation();
    }
  }

  private async stopReady(close: () => Promise<void>): Promise<void> {
    this.transition('stopping');
    this.setOperation('stop');
    try {
      await close();
      this.transition('unloaded');
    } catch (error) {
      this.fault('stop', error);
      throw error;
    } finally {
      this.operation = undefined;
      this.clearOperation();
    }
  }

  private transition(next: SessionLifecycleState): void {
    assertLifecycleTransition(this.snapshot.state, next);
    this.snapshot = {
      ...this.snapshot,
      state: next,
      revision: this.snapshot.revision + 1,
    };
    this.emit();
  }

  private fault(operation: string, error: unknown): void {
    if (this.snapshot.state === 'faulted') return;
    this.snapshot = {
      ...this.snapshot,
      state: 'faulted',
      revision: this.snapshot.revision + 1,
      lastError: {
        code: 'SESSION_FAULTED',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
        details: { operation, at: this.clock.now() },
      },
    };
    this.emit();
  }

  private setOperation(operation: SessionLifecycleSnapshot['activeOperation']): void {
    this.snapshot = { ...this.snapshot, activeOperation: operation };
    this.emit();
  }

  private clearOperation(): void {
    const { activeOperation: _activeOperation, ...rest } = this.snapshot;
    this.snapshot = rest;
    this.emit();
  }

  private emit(): void {
    this.onChange?.({ ...this.snapshot });
  }
}
