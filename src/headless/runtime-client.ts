import { applyProjectionFrame, type ProjectionFrame } from '../core/projection';
import type {
  CommandAck,
  CommandEnvelope,
  ProductProjection,
} from '../core/types';
import type {
  RuntimePort,
  RuntimeRequest,
  RuntimeResponse,
} from '../runtime/protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface Subscription {
  id: string;
  projection: ProductProjection;
}

export interface HeadlessRuntimeClientOptions {
  requestTimeoutMs?: number;
  clientId?: string;
}

export class HeadlessRuntimeClient {
  private port?: RuntimePort;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly projectionListeners = new Set<
    (sessionId: string, projection: ProductProjection) => void
  >();
  private readonly disconnectListeners = new Set<(error: Error) => void>();
  private ready?: Promise<void>;

  constructor(
    private readonly connectPort: () => RuntimePort,
    private readonly options: HeadlessRuntimeClientOptions = {}
  ) {}

  connect(): Promise<void> {
    this.ready ??= (async () => {
      await this.request({ type: 'hello', clientId: this.options.clientId ?? 'headless' });
    })();
    return this.ready;
  }

  async listSessions(): Promise<unknown[]> {
    await this.connect();
    return (await this.request({ type: 'list_sessions' })) as unknown[];
  }

  async loadProjection(sessionId: string): Promise<ProductProjection> {
    await this.connect();
    return (await this.request({
      type: 'get_projection',
      sessionId,
    })) as ProductProjection;
  }

  async subscribe(sessionId: string): Promise<ProductProjection> {
    await this.connect();
    const subscriptionId = `headless_subscription_${++this.sequence}`;
    const existing = this.subscriptions.get(sessionId);
    if (existing) await this.unsubscribe(sessionId);
    const projection = await this.loadProjection(sessionId);
    this.subscriptions.set(sessionId, { id: subscriptionId, projection });
    await this.request({ type: 'subscribe', sessionId, subscriptionId });
    return structuredClone(this.subscriptions.get(sessionId)!.projection);
  }

  async unsubscribe(sessionId: string): Promise<void> {
    if (!this.subscriptions.delete(sessionId)) return;
    await this.request({ type: 'unsubscribe', sessionId });
  }

  async command(command: CommandEnvelope): Promise<CommandAck> {
    await this.connect();
    return (await this.request({ type: 'command', command })) as CommandAck;
  }

  async stop(sessionId: string): Promise<void> {
    await this.connect();
    await this.request({ type: 'stop_session', sessionId });
  }

  async delete(sessionId: string): Promise<void> {
    await this.connect();
    await this.request({ type: 'delete_session', sessionId });
  }

  async rename(sessionId: string, title: string): Promise<void> {
    await this.connect();
    await this.request({ type: 'rename_session', sessionId, title });
  }

  onProjection(
    listener: (sessionId: string, projection: ProductProjection) => void
  ): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    this.close(new Error('Headless runtime client disconnected'));
  }

  private async request(request: RuntimeRequest): Promise<unknown> {
    const port = this.ensurePort();
    const requestId =
      request.requestId ?? `headless_${++this.sequence}_${Date.now()}`;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Runtime request timed out: ${request.type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      port.postMessage({ ...request, requestId } as RuntimeRequest);
    });
  }

  private ensurePort(): RuntimePort {
    if (this.port) return this.port;
    const port = this.connectPort();
    this.port = port;
    port.onMessage.addListener((message) => {
      this.onMessage(message as RuntimeResponse);
    });
    port.onDisconnect.addListener(() => {
      this.close(new Error('Runtime port disconnected'));
    });
    return port;
  }

  private onMessage(message: RuntimeResponse): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else {
        const error = new Error(message.error.message);
        error.name = message.error.code;
        pending.reject(error);
      }
      return;
    }
    if (message.type !== 'projection') return;
    const subscription = this.subscriptions.get(message.sessionId);
    if (
      !subscription ||
      (message.subscriptionId && message.subscriptionId !== subscription.id)
    ) {
      return;
    }
    try {
      subscription.projection = applyProjectionFrame(
        subscription.projection,
        message.frame as ProjectionFrame
      );
      for (const listener of this.projectionListeners) {
        listener(message.sessionId, structuredClone(subscription.projection));
      }
    } catch {
      void this.resync(message.sessionId, subscription.id);
    }
  }

  private async resync(sessionId: string, subscriptionId: string): Promise<void> {
    try {
      const projection = await this.loadProjection(sessionId);
      const subscription = this.subscriptions.get(sessionId);
      if (!subscription || subscription.id !== subscriptionId) return;
      subscription.projection = projection;
      for (const listener of this.projectionListeners) {
        listener(sessionId, structuredClone(projection));
      }
    } catch {
      // The disconnect/error path remains authoritative if the runtime vanished.
    }
  }

  private close(error: Error): void {
    this.port = undefined;
    this.ready = undefined;
    this.subscriptions.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener(error);
  }
}
