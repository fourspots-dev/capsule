import type { ExecutionEventInput } from './execution-event';
import type { DebugServiceConfig } from './debug-service-config';

export interface ChromeHttpEventTransportOptions {
  config: DebugServiceConfig;
  fetch?: typeof fetch;
  maxQueue?: number;
  maxQueuedBytes?: number;
  batchSize?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  setTimeout?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (timer: ReturnType<typeof setTimeout>) => void;
}

export class ChromeHttpEventTransport {
  private readonly config: DebugServiceConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly maxQueue: number;
  private readonly maxQueuedBytes: number;
  private readonly batchSize: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly scheduleTimeout: NonNullable<
    ChromeHttpEventTransportOptions['setTimeout']
  >;
  private readonly clearSchedule: NonNullable<
    ChromeHttpEventTransportOptions['clearTimeout']
  >;
  private readonly queue: Array<{ event: ExecutionEventInput; bytes: number }> = [];
  private queuedBytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private flushing?: Promise<void>;
  private retryAttempt = 0;
  private disposed = false;
  private lastError?: string;
  private connectionState: 'disabled' | 'idle' | 'sending' | 'retrying' | 'ready' =
    'idle';

  constructor(options: ChromeHttpEventTransportOptions) {
    this.config = options.config;
    this.fetchImpl =
      options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxQueue = Math.max(1, options.maxQueue ?? 2_000);
    this.maxQueuedBytes = Math.max(1, options.maxQueuedBytes ?? 2 * 1024 * 1024);
    this.batchSize = Math.max(1, options.batchSize ?? 100);
    this.retryBaseMs = Math.max(10, options.retryBaseMs ?? 500);
    this.retryMaxMs = Math.max(this.retryBaseMs, options.retryMaxMs ?? 30_000);
    this.now = options.now ?? (() => Date.now());
    this.scheduleTimeout =
      options.setTimeout ??
      ((callback, ms) => globalThis.setTimeout(callback, ms));
    this.clearSchedule =
      options.clearTimeout ??
      ((timer) => globalThis.clearTimeout(timer));
    if (!this.config.enabled) this.connectionState = 'disabled';
  }

  emit(event: ExecutionEventInput): void {
    if (this.disposed || !this.config.enabled) return;
    const normalized = event.timestamp
      ? event
      : { ...event, timestamp: this.now() };
    const bytes = JSON.stringify(normalized).length * 2;
    this.queue.push({ event: normalized, bytes });
    this.queuedBytes += bytes;
    while (
      this.queue.length > this.maxQueue ||
      this.queuedBytes > this.maxQueuedBytes
    ) {
      const removed = this.queue.shift();
      if (!removed) break;
      this.queuedBytes -= removed.bytes;
    }
    this.scheduleFlush(0);
  }

  flush(): Promise<void> {
    if (this.disposed || !this.config.enabled) return Promise.resolve();
    if (this.flushing) return this.flushing;
    if (this.queue.length === 0) return Promise.resolve();
    this.clearScheduledFlush();
    const batch = this.queue.slice(0, this.batchSize);
    this.connectionState = 'sending';
    this.flushing = (async () => {
      try {
        const response = await this.fetchImpl(`${this.config.endpoint}/v1/ingest`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.config.token
              ? { Authorization: `Bearer ${this.config.token}` }
              : {}),
          },
          body: JSON.stringify({ events: batch.map((item) => item.event) }),
        });
        if (!response.ok) {
          throw new Error(`Debug ingest failed: HTTP ${response.status}`);
        }
        const acknowledged = new Set(
          batch.map(({ event }) => `${event.sessionId}:${event.clientEventId}`)
        );
        for (let index = this.queue.length - 1; index >= 0; index -= 1) {
          const item = this.queue[index];
          if (
            acknowledged.has(
              `${item.event.sessionId}:${item.event.clientEventId}`
            )
          ) {
            this.queue.splice(index, 1);
            this.queuedBytes -= item.bytes;
          }
        }
        this.retryAttempt = 0;
        this.lastError = undefined;
        this.connectionState = 'ready';
        if (this.queue.length) this.scheduleFlush(0);
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error);
        console.warn('tinyai debug event upload failed', error);
        this.connectionState = 'retrying';
        const delay = Math.min(
          this.retryMaxMs,
          this.retryBaseMs * 2 ** this.retryAttempt++
        );
        this.scheduleFlush(delay);
      } finally {
        this.flushing = undefined;
      }
    })();
    return this.flushing;
  }

  status(): {
    enabled: boolean;
    state: string;
    queued: number;
    queuedBytes: number;
    lastError?: string;
  } {
    return {
      enabled: this.config.enabled,
      state: this.connectionState,
      queued: this.queue.length,
      queuedBytes: this.queuedBytes,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }

  async dispose(): Promise<void> {
    this.clearScheduledFlush();
    await this.flush();
    this.disposed = true;
  }

  private scheduleFlush(delayMs: number): void {
    if (this.disposed || this.timer !== undefined || this.flushing) return;
    this.timer = this.scheduleTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, delayMs);
  }

  private clearScheduledFlush(): void {
    if (this.timer === undefined) return;
    this.clearSchedule(this.timer);
    this.timer = undefined;
  }
}
