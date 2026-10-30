import type { ApprovalPort, ApprovalRequest, HandoffPort } from '../core/ports';
import type { RuntimePort } from './protocol';

interface PendingApproval {
  request: ApprovalRequest;
  resolve(value: boolean): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

interface PendingHandoff {
  resolve(value: 'continue' | 'cancel'): void;
  timer?: ReturnType<typeof setTimeout>;
}

export class PortApprovalBroker implements ApprovalPort, HandoffPort {
  private readonly ports = new Set<RuntimePort>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly handoffs = new Map<string, PendingHandoff>();
  private sequence = 0;

  constructor(
    private readonly options: {
      mode: 'ask' | 'auto';
      timeoutMs?: number;
    }
  ) {}

  attach(port: RuntimePort): () => void {
    this.ports.add(port);
    return () => this.ports.delete(port);
  }

  detach(port: RuntimePort): void {
    this.ports.delete(port);
  }

  requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (this.options.mode === 'auto') return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);
    const approvalId = `approval_${++this.sequence}`;
    return new Promise<boolean>((resolve, reject) => {
      const timeoutMs = this.options.timeoutMs ?? 60_000;
      const abort = (): void => {
        this.finish(approvalId, false);
        reject(new Error('Approval was cancelled'));
      };
      const timer = setTimeout(() => {
        this.finish(approvalId, false);
        reject(new Error('Approval timed out'));
      }, timeoutMs);
      this.pending.set(approvalId, { request, resolve, reject, timer });
      signal.addEventListener('abort', abort, { once: true });
      for (const port of this.ports) {
        port.postMessage({
          type: 'approval_request',
          approvalId,
          sessionId: request.sessionId,
          taskId: request.taskId,
          callId: request.callId,
          toolName: request.toolName,
          risk: request.risk,
          input: request.input,
        });
      }
    });
  }

  respond(approvalId: string, approved: boolean): boolean {
    return this.finish(approvalId, approved);
  }

  requestHandoff(
    reason: string,
    context: { sessionId: string; taskId: string; toolName: string },
    signal: AbortSignal
  ): Promise<'continue' | 'cancel'> {
    if (signal.aborted) return Promise.resolve('cancel');
    const handoffId = `handoff_${++this.sequence}`;
    return new Promise<'continue' | 'cancel'>((resolve) => {
      const timeoutMs = this.options.timeoutMs ?? 60_000;
      const timer = setTimeout(() => this.finishHandoff(handoffId, 'cancel'), timeoutMs);
      this.handoffs.set(handoffId, { resolve, timer });
      const abort = () => this.finishHandoff(handoffId, 'cancel');
      signal.addEventListener('abort', abort, { once: true });
      for (const port of this.ports) {
        port.postMessage({
          type: 'handoff_request',
          handoffId,
          sessionId: context.sessionId,
          taskId: context.taskId,
          toolName: context.toolName,
          reason,
        });
      }
    });
  }

  respondHandoff(handoffId: string, decision: 'continue' | 'cancel'): boolean {
    return this.finishHandoff(handoffId, decision);
  }

  dispose(): void {
    for (const [approvalId] of this.pending) this.finish(approvalId, false);
    for (const [handoffId] of this.handoffs) this.finishHandoff(handoffId, 'cancel');
    this.ports.clear();
  }

  private finish(approvalId: string, approved: boolean): boolean {
    const pending = this.pending.get(approvalId);
    if (!pending) return false;
    this.pending.delete(approvalId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(approved);
    return true;
  }

  private finishHandoff(handoffId: string, decision: 'continue' | 'cancel'): boolean {
    const pending = this.handoffs.get(handoffId);
    if (!pending) return false;
    this.handoffs.delete(handoffId);
    if (pending.timer) clearTimeout(pending.timer);
    pending.resolve(decision);
    return true;
  }
}
