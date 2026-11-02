import { AgentError } from './errors';
import type { RuntimeEvent } from './event-log';
import type { Clock, IdGenerator, ModelTransport } from './ports';
import type { PermissionMode, PermissionModeRegistry } from './policy';
import {
  SessionRuntime,
  type SessionProjectionChange,
} from './session-runtime';
import type { CompletionGuard } from './session-runtime';
import type { SessionStore, SessionSummary } from './session-store';
import type { ToolExecutor } from './tool-executor';
import type { TraceRecorder } from './trace-recorder';
import type {
  CommandAck,
  CommandEnvelope,
  ChildTaskProjection,
  ModelMessage,
  ProductProjection,
  SessionView,
} from './types';

export interface WorkspaceRuntimeOptions {
  model: ModelTransport;
  tools: ToolExecutor;
  clock: Clock;
  ids: IdGenerator;
  systemPrompt?: string;
  systemPromptForMode?: (mode: PermissionMode) => string;
  maxSteps?: number;
  sessionStore?: SessionStore;
  onOpen?: (sessionId: string) => Promise<void>;
  onClose?: (sessionId: string) => Promise<void>;
  permissionModes?: PermissionModeRegistry;
  trace?: TraceRecorder;
  completionGuard?: CompletionGuard;
  onProjectionChange?: (change: SessionProjectionChange) => void;
  maxResidentSessions?: number;
}

export class WorkspaceRuntime {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly loading = new Map<string, Promise<SessionRuntime | undefined>>();
  private readonly commandTails = new Map<string, Promise<void>>();
  private readonly lastAccess = new Map<string, number>();

  constructor(private readonly options: WorkspaceRuntimeOptions) {}

  getSessionView(sessionId: string): SessionView | undefined {
    const runtime = this.sessions.get(sessionId);
    if (runtime) this.touchAccess(sessionId);
    return runtime?.view();
  }

  getProjection(sessionId: string): ProductProjection {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    this.touchAccess(sessionId);
    return runtime.projection();
  }

  async loadProjection(sessionId: string): Promise<ProductProjection> {
    const runtime = await this.ensureSession(sessionId, false);
    if (!runtime) {
      throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
    await runtime.ensureReady();
    return runtime.projection();
  }

  async ensureSessionReady(sessionId: string): Promise<void> {
    const runtime = await this.ensureSession(sessionId, true);
    if (!runtime) {
      throw new AgentError('SESSION_CREATE_FAILED', `Failed to create session: ${sessionId}`);
    }
    await runtime.ensureReady();
  }

  async hydrateSession(sessionId: string): Promise<SessionView | undefined> {
    const runtime = await this.ensureSession(sessionId, false);
    return runtime?.view();
  }

  command(command: CommandEnvelope): Promise<CommandAck> {
    const previous = this.commandTails.get(command.sessionId) ?? Promise.resolve();
    const next = previous.then(() => this.processCommand(command));
    this.commandTails.set(
      command.sessionId,
      next.then(
        () => undefined,
        () => undefined
      )
    );
    return next;
  }

  private async processCommand(command: CommandEnvelope): Promise<CommandAck> {
    if (command.type === 'send_input') await this.ensureSessionReady(command.sessionId);
    const runtime = await this.ensureSession(command.sessionId, false);
    if (!runtime) {
      return {
        commandId: command.commandId,
        sessionId: command.sessionId,
        status: 'rejected',
        revision: 0,
        error: {
          code: 'SESSION_NOT_FOUND',
          message: `Session not found: ${command.sessionId}`,
          retryable: false,
        },
      };
    }
    if (runtime.lifecycle.getState().state !== 'ready') {
      await runtime.ensureReady();
    }
    return runtime.command(command);
  }

  waitForSessionIdle(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return Promise.resolve();
    return runtime.waitForIdle();
  }

  eventLog(sessionId: string): RuntimeEvent[] {
    return this.sessions.get(sessionId)?.eventLog() ?? [];
  }

  queryCommand(sessionId: string, commandId: string): CommandAck | undefined {
    return this.sessions.get(sessionId)?.queryCommand(commandId);
  }

  updateChildTask(parentTaskId: string, child: ChildTaskProjection): boolean {
    for (const runtime of this.sessions.values()) {
      if (runtime.updateChildTask(parentTaskId, child)) return true;
    }
    return false;
  }

  contextForTask(taskId: string): ModelMessage[] {
    for (const runtime of this.sessions.values()) {
      if (runtime.ownsTask(taskId)) return runtime.contextMessages();
    }
    throw new AgentError('TASK_NOT_FOUND', `Task not found in active sessions: ${taskId}`);
  }

  async subscribe(
    sessionId: string,
    listener: (projection: ProductProjection) => void
  ): Promise<() => void> {
    const runtime = await this.ensureSession(sessionId, false);
    if (!runtime) return () => undefined;
    return runtime.subscribe(listener);
  }

  async subscribeChanges(
    sessionId: string,
    listener: (change: SessionProjectionChange) => void
  ): Promise<{
    initial: ProductProjection;
    unsubscribe: () => void;
  } | undefined> {
    const runtime = await this.ensureSession(sessionId, false);
    return runtime?.subscribeChanges(listener);
  }

  async stop(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    await runtime.stopInstance();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (runtime) {
      await runtime.stopInstance();
      await runtime.flushPersistence();
    }
    this.sessions.delete(sessionId);
    await this.options.sessionStore?.remove(sessionId);
  }

  async deleteAllSessions(): Promise<number> {
    await Promise.allSettled([...this.loading.values()]);
    const loaded = [...this.sessions.values()];
    await Promise.all(
      loaded.map(async (runtime) => {
        await runtime.stopInstance();
        await runtime.flushPersistence();
      })
    );
    const persisted = (await this.options.sessionStore?.list?.()) ?? [];
    const count = new Set([
      ...this.sessions.keys(),
      ...persisted.map((session) => session.sessionId),
    ]).size;
    this.sessions.clear();
    this.loading.clear();
    this.commandTails.clear();
    if (this.options.sessionStore?.clear) {
      await this.options.sessionStore.clear();
    } else {
      await Promise.all(
        persisted.map((session) =>
          this.options.sessionStore?.remove(session.sessionId)
        )
      );
    }
    return count;
  }

  async restart(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    await runtime.restartInstance();
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const runtime = await this.ensureSession(sessionId, false);
    if (!runtime) {
      throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
    runtime.rename(title);
    await runtime.flushPersistence();
  }

  async flush(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.flushPersistence();
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = new Map(
      ((await this.options.sessionStore?.list?.()) ?? []).map((session) => [
        session.sessionId,
        session,
      ])
    );
    for (const [sessionId, runtime] of this.sessions) {
      sessions.set(sessionId, runtime.summary());
    }
    return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async dispose(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        await session.stopInstance();
        await session.flushPersistence();
      })
    );
    this.sessions.clear();
    this.loading.clear();
    this.commandTails.clear();
  }

  private createRuntime(sessionId: string, initialSnapshot?: Awaited<ReturnType<SessionStore['load']>>): SessionRuntime {
    const runtime = new SessionRuntime({
      ...this.options,
      sessionId,
      initialSnapshot,
    });
    if (this.options.onProjectionChange) {
      runtime.subscribeChanges(this.options.onProjectionChange);
    }
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private async ensureSession(
    sessionId: string,
    createWhenMissing: boolean
  ): Promise<SessionRuntime | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      this.touchAccess(sessionId);
      return existing;
    }
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const load = (async () => {
      let initialSnapshot;
      try {
        initialSnapshot = await this.options.sessionStore?.load(sessionId);
      } catch {
        initialSnapshot = undefined;
      }
      if (initialSnapshot) {
        const created = this.createRuntime(sessionId, initialSnapshot);
        this.touchAccess(sessionId);
        await this.evictInactiveSessions(sessionId);
        return created;
      }
      if (!createWhenMissing) return undefined;
      const created = this.createRuntime(sessionId);
      this.touchAccess(sessionId);
      await this.evictInactiveSessions(sessionId);
      return created;
    })();
    this.loading.set(sessionId, load);
    try {
      return await load;
    } finally {
      this.loading.delete(sessionId);
    }
  }

  private touchAccess(sessionId: string): void {
    this.lastAccess.set(sessionId, Date.now());
  }

  private async evictInactiveSessions(keepSessionId: string): Promise<void> {
    if (!this.options.sessionStore) return;
    const maximum = Math.max(1, this.options.maxResidentSessions ?? 6);
    if (this.sessions.size <= maximum) return;
    const candidates = [...this.sessions.entries()]
      .filter(([sessionId, runtime]) => sessionId !== keepSessionId && runtime.canEvict())
      .sort(
        ([left], [right]) =>
          (this.lastAccess.get(left) ?? 0) - (this.lastAccess.get(right) ?? 0)
      );
    for (const [sessionId, runtime] of candidates) {
      if (this.sessions.size <= maximum) break;
      await runtime.flushPersistence();
      this.sessions.delete(sessionId);
      this.lastAccess.delete(sessionId);
    }
  }
}
