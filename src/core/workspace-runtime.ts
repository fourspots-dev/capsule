import { AgentError } from './errors';
import type { RuntimeEvent } from './event-log';
import type { Clock, IdGenerator, ModelTransport } from './ports';
import type { PermissionModeRegistry } from './policy';
import { SessionRuntime } from './session-runtime';
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
  maxSteps?: number;
  sessionStore?: SessionStore;
  onOpen?: (sessionId: string) => Promise<void>;
  onClose?: (sessionId: string) => Promise<void>;
  permissionModes?: PermissionModeRegistry;
  trace?: TraceRecorder;
}

export class WorkspaceRuntime {
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly loading = new Map<string, Promise<SessionRuntime | undefined>>();
  private readonly commandTails = new Map<string, Promise<void>>();

  constructor(private readonly options: WorkspaceRuntimeOptions) {}

  getSessionView(sessionId: string): SessionView | undefined {
    return this.sessions.get(sessionId)?.view();
  }

  getProjection(sessionId: string): ProductProjection {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
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

  async stop(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) return;
    await runtime.stopInstance();
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.stop(sessionId);
    this.sessions.delete(sessionId);
    await this.options.sessionStore?.remove(sessionId);
  }

  async restart(sessionId: string): Promise<void> {
    const runtime = this.sessions.get(sessionId);
    if (!runtime) throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    await runtime.restartInstance();
  }

  async flush(sessionId: string): Promise<void> {
    await this.sessions.get(sessionId)?.flushPersistence();
  }

  async listSessions(): Promise<SessionSummary[]> {
    const sessions = (await this.options.sessionStore?.list?.()) ?? [];
    return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
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
    this.sessions.set(sessionId, runtime);
    return runtime;
  }

  private async ensureSession(
    sessionId: string,
    createWhenMissing: boolean
  ): Promise<SessionRuntime | undefined> {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const pending = this.loading.get(sessionId);
    if (pending) return pending;
    const load = (async () => {
      let initialSnapshot;
      try {
        initialSnapshot = await this.options.sessionStore?.load(sessionId);
      } catch {
        initialSnapshot = undefined;
      }
      if (initialSnapshot) return this.createRuntime(sessionId, initialSnapshot);
      return createWhenMissing ? this.createRuntime(sessionId) : undefined;
    })();
    this.loading.set(sessionId, load);
    try {
      return await load;
    } finally {
      this.loading.delete(sessionId);
    }
  }
}
