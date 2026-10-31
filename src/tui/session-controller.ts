import { AgentError } from '../core/errors';
import {
  applyProjectionFrame,
  type ProjectionFrame,
} from '../core/projection';
import type {
  CommandAck,
  ConversationCommandType,
  ProductProjection,
} from '../core/types';
import type {
  ProjectionEnvelope,
  TuiRuntimePort,
  TuiRoute,
} from './types';
import type { ViewStateStore } from './view-state-store';

interface ActiveSubscription {
  sessionId: string;
  subscriptionId: string;
  dispose: () => void;
}

export class SessionController {
  private activeSessionId?: string;
  private projection?: ProductProjection;
  private subscription?: ActiveSubscription;
  private generation = 0;
  private commandSequence = 0;
  private readonly listeners = new Set<(projection: ProductProjection) => void>();

  constructor(
    private readonly runtime: TuiRuntimePort,
    private readonly viewState: ViewStateStore,
    private readonly now: () => number = () => Date.now()
  ) {}

  get active(): string | undefined {
    return this.activeSessionId;
  }

  get currentProjection(): ProductProjection | undefined {
    return this.projection ? structuredClone(this.projection) : undefined;
  }

  async initialize(): Promise<string | undefined> {
    await this.viewState.initialize();
    const last = this.viewState.active;
    if (last) {
      try {
        await this.switch(last);
        return last;
      } catch {
        // A deleted last session must not block TUI startup.
      }
    }
    return undefined;
  }

  async switch(sessionId: string): Promise<ProductProjection> {
    const generation = ++this.generation;
    const subscriptionId = `tui_subscription_${generation}`;
    const current = this.activeSessionId;
    if (current) await this.viewState.flush();
    this.subscription?.dispose();
    this.subscription = undefined;

    const projection = await this.runtime.loadProjection(sessionId);
    if (generation !== this.generation) return projection;
    this.projection = structuredClone(projection);
    this.activeSessionId = sessionId;
    await this.viewState.setActive(sessionId);
    const dispose = await this.runtime.subscribe(
      sessionId,
      subscriptionId,
      (envelope) => this.receive(envelope, generation)
    );
    if (generation !== this.generation) {
      dispose();
      return projection;
    }
    this.subscription = { sessionId, subscriptionId, dispose };
    this.emit();
    return this.currentProjection!;
  }

  activateLocal(sessionId: string): void {
    this.generation += 1;
    this.subscription?.dispose();
    this.subscription = undefined;
    this.activeSessionId = sessionId;
    this.projection = undefined;
    void this.viewState.setActive(sessionId);
  }

  receive(envelope: ProjectionEnvelope, generation = this.generation): boolean {
    if (generation !== this.generation || envelope.sessionId !== this.activeSessionId) {
      return false;
    }
    if (
      this.subscription &&
      envelope.subscriptionId &&
      envelope.subscriptionId !== this.subscription.subscriptionId
    ) {
      return false;
    }
    const frameSessionId =
      envelope.frame.type === 'snapshot'
        ? envelope.frame.projection.sessionId
        : envelope.frame.sessionId;
    const frameEpoch =
      envelope.frame.type === 'snapshot'
        ? envelope.frame.projection.logEpoch
        : envelope.frame.logEpoch;
    if (frameSessionId !== envelope.sessionId || frameEpoch !== envelope.logEpoch) {
      return false;
    }
    if (!this.projection) {
      if (envelope.frame.type !== 'snapshot') return false;
      this.projection = structuredClone(envelope.frame.projection);
      this.emit();
      return true;
    }
    if (this.projection.logEpoch !== envelope.logEpoch) {
      if (envelope.frame.type !== 'snapshot') return false;
      this.projection = structuredClone(envelope.frame.projection);
      this.emit();
      return true;
    }
    try {
      this.projection = applyProjectionFrame(
        this.projection,
        envelope.frame as ProjectionFrame
      );
    } catch {
      return false;
    }
    this.emit();
    return true;
  }

  async send(text: string): Promise<CommandAck> {
    return this.command('send_input', { text });
  }

  async stop(): Promise<CommandAck> {
    return this.command('stop', { reason: 'tui_stop' });
  }

  async compact(summary?: string): Promise<CommandAck> {
    return this.command('compact', { ...(summary ? { summary } : {}) });
  }

  subscribe(listener: (projection: ProductProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.generation += 1;
    this.subscription?.dispose();
    this.subscription = undefined;
    await this.viewState.flush();
    this.listeners.clear();
  }

  private async command(
    type: ConversationCommandType,
    payload: CommandEnvelopePayload
  ): Promise<CommandAck> {
    if (!this.activeSessionId) {
      throw new AgentError('TUI_SESSION_REQUIRED', 'Select a Session before sending');
    }
    return this.runtime.command({
      commandId: `tui_${++this.commandSequence}_${this.now()}`,
      clientId: 'tui',
      sessionId: this.activeSessionId,
      type,
      payload,
      ...(this.projection ? { baseRevision: this.projection.revision } : {}),
      issuedAt: this.now(),
    });
  }

  private emit(): void {
    if (!this.projection) return;
    const projection = structuredClone(this.projection);
    for (const listener of this.listeners) listener(projection);
  }
}

type CommandEnvelopePayload =
  | { text: string; delivery?: 'startNow' | 'guide' | 'queue' }
  | { reason?: string }
  | { summary?: string };

export interface TuiNavigationTarget {
  route: TuiRoute;
  sessionId?: string;
}
