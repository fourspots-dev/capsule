import type {
  ApprovalDecision,
  ApprovalReceipt,
  ApprovalReceiptStore,
} from '../core/ports';
import type { HostStorage } from '../host';

export class HostApprovalReceiptStore implements ApprovalReceiptStore {
  constructor(
    private readonly storage: HostStorage,
    private readonly options: {
      keyPrefix?: string;
      now?: () => number;
    } = {}
  ) {}

  async record(receipt: ApprovalReceipt): Promise<void> {
    await this.storage.set(
      `${this.options.keyPrefix ?? 'tinyai:approval:v1:'}${encodeURIComponent(receipt.id)}`,
      receipt
    );
  }

  async list(
    filter: { sessionId?: string; taskId?: string } = {}
  ): Promise<ApprovalReceipt[]> {
    const prefix = this.options.keyPrefix ?? 'tinyai:approval:v1:';
    const keys = (await this.storage.list?.(prefix)) ?? [];
    const receipts: ApprovalReceipt[] = [];
    for (const key of keys) {
      const receipt = validateReceipt(await this.storage.get(key));
      if (!receipt) continue;
      if (filter.sessionId && receipt.sessionId !== filter.sessionId) continue;
      if (filter.taskId && receipt.taskId !== filter.taskId) continue;
      receipts.push(receipt);
    }
    return receipts.sort((left, right) => left.createdAt - right.createdAt);
  }
}

export class InMemoryApprovalReceiptStore implements ApprovalReceiptStore {
  private readonly receipts = new Map<string, ApprovalReceipt>();

  async record(receipt: ApprovalReceipt): Promise<void> {
    this.receipts.set(receipt.id, structuredClone(receipt));
  }

  async list(
    filter: { sessionId?: string; taskId?: string } = {}
  ): Promise<ApprovalReceipt[]> {
    return [...this.receipts.values()]
      .filter(
        (receipt) =>
          (!filter.sessionId || receipt.sessionId === filter.sessionId) &&
          (!filter.taskId || receipt.taskId === filter.taskId)
      )
      .map((receipt) => structuredClone(receipt))
      .sort((left, right) => left.createdAt - right.createdAt);
  }
}

function validateReceipt(value: unknown): ApprovalReceipt | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const receipt = value as Partial<ApprovalReceipt>;
  const decisions: ApprovalDecision[] = [
    'approved',
    'denied',
    'cancelled',
    'failed',
  ];
  if (
    typeof receipt.id !== 'string' ||
    typeof receipt.sessionId !== 'string' ||
    typeof receipt.taskId !== 'string' ||
    typeof receipt.callId !== 'string' ||
    typeof receipt.toolName !== 'string' ||
    (receipt.risk !== 'write' && receipt.risk !== 'dangerous') ||
    !decisions.includes(receipt.decision as ApprovalDecision) ||
    typeof receipt.inputDigest !== 'string' ||
    typeof receipt.createdAt !== 'number'
  ) {
    return undefined;
  }
  return structuredClone(receipt as ApprovalReceipt);
}
