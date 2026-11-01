import type { JsonValue, ModelEvent, ModelRequest } from './types';

export interface Clock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface IdGenerator {
  next(prefix: string): string;
  reserve?(ids: Iterable<string>): void;
}

export interface ModelTransport {
  stream(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export interface ApprovalRequest {
  sessionId: string;
  taskId: string;
  callId: string;
  toolName: string;
  risk: 'write' | 'dangerous';
  input: unknown;
  actionDigest?: string;
}

export interface ApprovalPort {
  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean>;
}

export type ApprovalDecision =
  | 'approved'
  | 'denied'
  | 'cancelled'
  | 'failed';

export interface ApprovalReceipt {
  id: string;
  sessionId: string;
  taskId: string;
  callId: string;
  toolName: string;
  risk: 'write' | 'dangerous';
  decision: ApprovalDecision;
  inputDigest: string;
  actionDigest?: string;
  approvalContext?: JsonValue;
  createdAt: number;
}

export interface ApprovalReceiptStore {
  record(receipt: ApprovalReceipt): Promise<void>;
  list(filter?: {
    sessionId?: string;
    taskId?: string;
  }): Promise<ApprovalReceipt[]>;
}

export interface HandoffPort {
  requestHandoff(
    reason: string,
    context: { sessionId: string; taskId: string; toolName: string },
    signal: AbortSignal
  ): Promise<'continue' | 'cancel'>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class SequentialIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();

  next(prefix: string): string {
    const next = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, next);
    return `${prefix}_${next}`;
  }

  reserve(ids: Iterable<string>): void {
    for (const id of ids) {
      const match = id.match(/^(.+)_(\d+)$/);
      if (!match) continue;
      const prefix = match[1];
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) continue;
      this.counters.set(prefix, Math.max(this.counters.get(prefix) ?? 0, value));
    }
  }
}
