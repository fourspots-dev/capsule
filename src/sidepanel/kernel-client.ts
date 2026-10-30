import type { CommandAck, CommandEnvelope, ProductProjection } from '../core/types';
import type { SkillDefinition } from '../core/extension-registry';
import {
  ProjectionStore,
  type ProjectionFrame,
} from '../core/projection';
import type {
  RuntimePort,
  RuntimeRequest,
  RuntimeResponse,
} from '../runtime/protocol';

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>;
}

export interface KernelApprovalEvent {
  approvalId: string;
  sessionId: string;
  taskId: string;
  callId: string;
  toolName: string;
  risk: 'write' | 'dangerous';
  input: unknown;
}

export interface KernelHandoffEvent {
  handoffId: string;
  sessionId: string;
  taskId: string;
  toolName: string;
  reason: string;
}

export class KernelClient {
  private port?: RuntimePort;
  private sequence = 0;
  private readonly pending = new Map<string, Pending>();
  private readonly projectionListeners = new Set<
    (sessionId: string, projection: ProductProjection) => void
  >();
  private readonly approvalListeners = new Set<(event: KernelApprovalEvent) => void>();
  private readonly handoffListeners = new Set<(event: KernelHandoffEvent) => void>();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly resyncing = new Set<string>();

  constructor(
    private readonly connectPort: () => RuntimePort,
    private readonly options: { requestTimeoutMs?: number } = {}
  ) {}

  async command(command: CommandEnvelope): Promise<CommandAck> {
    return (await this.request({ type: 'command', command })) as CommandAck;
  }

  async subscribe(sessionId: string): Promise<void> {
    await this.request({ type: 'subscribe', sessionId });
  }

  async unsubscribe(sessionId: string): Promise<void> {
    await this.request({ type: 'unsubscribe', sessionId });
  }

  async projection(sessionId: string): Promise<ProductProjection> {
    return (await this.request({ type: 'get_projection', sessionId })) as ProductProjection;
  }

  async stopSession(sessionId: string): Promise<void> {
    await this.request({ type: 'stop_session', sessionId });
  }

  async listSessions(): Promise<
    Array<{
      sessionId: string;
      title: string;
      updatedAt: number;
      taskStatus: string;
      rowCount: number;
    }>
  > {
    return (await this.request({ type: 'list_sessions' })) as never;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.request({ type: 'delete_session', sessionId });
  }

  async restartSession(sessionId: string): Promise<void> {
    await this.request({ type: 'restart_session', sessionId });
  }

  async listSkills(): Promise<SkillDefinition[]> {
    return (await this.request({ type: 'list_skills' })) as SkillDefinition[];
  }

  async reloadRuntime(): Promise<void> {
    await this.request({ type: 'reload_runtime' });
  }

  async readArtifact(artifactId: string): Promise<{
    metadata: { id: string; name: string; mimeType: string; bytes: number; kind: string };
    dataBase64: string;
  }> {
    return (await this.request({
      type: 'read_artifact',
      artifactId,
    })) as never;
  }

  async listTabs(): Promise<
    Array<{ id: string; title?: string; url?: string; active: boolean }>
  > {
    return (await this.request({ type: 'list_tabs' })) as never;
  }

  async selectTab(sessionId: string, tabId: string): Promise<void> {
    await this.request({ type: 'select_tab', sessionId, tabId });
  }

  async respondApproval(approvalId: string, approved: boolean): Promise<void> {
    await this.request({ type: 'approval_response', approvalId, approved });
  }

  async respondHandoff(handoffId: string, decision: 'continue' | 'cancel'): Promise<void> {
    await this.request({ type: 'handoff_response', handoffId, decision });
  }

  onProjection(
    listener: (sessionId: string, projection: ProductProjection) => void
  ): () => void {
    this.projectionListeners.add(listener);
    return () => this.projectionListeners.delete(listener);
  }

  onApproval(listener: (event: KernelApprovalEvent) => void): () => void {
    this.approvalListeners.add(listener);
    return () => this.approvalListeners.delete(listener);
  }

  onHandoff(listener: (event: KernelHandoffEvent) => void): () => void {
    this.handoffListeners.add(listener);
    return () => this.handoffListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  disconnect(): void {
    this.clearConnection(new Error('Kernel client disconnected'));
  }

  private async request(request: RuntimeRequest): Promise<unknown> {
    const port = this.ensurePort();
    const requestId = request.requestId ?? `client_${++this.sequence}`;
    const message = { ...request, requestId } as RuntimeRequest;
    return new Promise((resolve, reject) => {
      const timeoutMs = this.options.requestTimeoutMs ?? 30_000;
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Kernel request timed out: ${request.type}`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timer });
      port.postMessage(message);
    });
  }

  private ensurePort(): RuntimePort {
    if (this.port) return this.port;
    const port = this.connectPort();
    this.port = port;
    port.onMessage.addListener((message) => this.onMessage(message as RuntimeResponse));
    port.onDisconnect.addListener(() =>
      this.clearConnection(new Error('Kernel runtime disconnected'))
    );
    return port;
  }

  private onMessage(message: RuntimeResponse): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      this.pending.delete(message.requestId);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else {
        const error = new Error(message.error.message);
        error.name = message.error.code;
        pending.reject(error);
      }
      return;
    }
    if (message.type === 'projection') {
      const projection = this.applyFrame(message.frame);
      if (projection) {
        for (const listener of this.projectionListeners) {
          listener(projection.sessionId, projection);
        }
      }
      return;
    }
    if (message.type === 'approval_request') {
      const { type: _type, ...event } = message;
      for (const listener of this.approvalListeners) listener(event);
      return;
    }
    if (message.type === 'handoff_request') {
      const { type: _type, ...event } = message;
      for (const listener of this.handoffListeners) listener(event);
    }
  }

  private readonly stores = new Map<string, ProjectionStore>();

  private applyFrame(frame: ProjectionFrame): ProductProjection | undefined {
    if (frame.type === 'snapshot') {
      const store = new ProjectionStore();
      const projection = store.apply(frame);
      this.stores.set(projection.sessionId, store);
      return projection;
    }
    const store = this.stores.get(frame.sessionId);
    if (!store) {
      this.clearConnection(new Error('Projection delta arrived without a snapshot'));
      return undefined;
    }
    const current = store.snapshot();
    if (current && frame.revision <= current.revision) return current;
    try {
      return store.apply(frame);
    } catch (error) {
      void this.resync(frame.sessionId);
      return undefined;
    }
  }

  private async resync(sessionId: string): Promise<void> {
    if (this.resyncing.has(sessionId)) return;
    this.resyncing.add(sessionId);
    try {
      const projection = await this.projection(sessionId);
      const store = new ProjectionStore();
      const applied = store.apply({ type: 'snapshot', projection });
      this.stores.set(sessionId, store);
      for (const listener of this.projectionListeners) listener(sessionId, applied);
    } finally {
      this.resyncing.delete(sessionId);
    }
  }

  private clearConnection(error: Error): void {
    this.port = undefined;
    this.stores.clear();
    this.resyncing.clear();
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.disconnectListeners) listener();
  }
}

export function connectChromeKernelPort(
  api: typeof chrome,
  name = 'tinyai-runtime-v1'
): RuntimePort {
  const port = api.runtime.connect({ name });
  const messageWrappers = new Map<
    (message: RuntimeRequest | RuntimeResponse) => void,
    (message: unknown) => void
  >();
  const disconnectWrappers = new Map<() => void, () => void>();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: {
      addListener: (listener) => {
        const wrapped = (message: unknown) => listener(message as RuntimeResponse);
        messageWrappers.set(listener, wrapped);
        port.onMessage.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = messageWrappers.get(listener);
        if (!wrapped) return;
        port.onMessage.removeListener(wrapped);
        messageWrappers.delete(listener);
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        const wrapped = () => listener();
        disconnectWrappers.set(listener, wrapped);
        port.onDisconnect.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = disconnectWrappers.get(listener);
        if (!wrapped) return;
        port.onDisconnect.removeListener(wrapped);
        disconnectWrappers.delete(listener);
      },
    },
  };
}
