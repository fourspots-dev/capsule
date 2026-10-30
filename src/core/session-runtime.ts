import { AgentLoop } from './agent-loop';
import { CommandInbox } from './command-inbox';
import { appendCompaction } from './compaction';
import { buildModelContext } from './context-manager';
import { AgentError, isAbortError, toStructuredError } from './errors';
import { EventLog, type RuntimeEvent } from './event-log';
import { InputLedger } from './input-ledger';
import type { Clock, IdGenerator, ModelTransport } from './ports';
import { PermissionModeRegistry, type PermissionMode } from './policy';
import { buildProjection } from './projection';
import { SessionLifecycleController } from './session-lifecycle';
import { cloneSnapshot, type SessionSnapshot, type SessionStore } from './session-store';
import { SessionTree, type SessionEntry, type SessionMessagePayload } from './session-tree';
import { TaskGraph } from './task-graph';
import type { TraceRecorder } from './trace-recorder';
import { toolResultText, type ToolExecutor } from './tool-executor';
import type {
  AgentLoopEvent,
  ChildTaskProjection,
  CommandAck,
  CommandEnvelope,
  CompactPayload,
  ConversationRow,
  ModelMessage,
  ProductProjection,
  PlanPayload,
  SendInputPayload,
  SessionView,
  SetModePayload,
  StructuredError,
  TaskStatus,
} from './types';

interface QueueItem {
  inputId: string;
  commandId: string;
  taskId: string;
  text: string;
  modelText: string;
}

export interface SessionRuntimeOptions {
  sessionId: string;
  model: ModelTransport;
  tools: ToolExecutor;
  clock: Clock;
  ids: IdGenerator;
  logEpoch?: string;
  systemPrompt?: string;
  maxSteps?: number;
  sessionStore?: SessionStore;
  initialSnapshot?: SessionSnapshot;
  onOpen?: (sessionId: string) => Promise<void>;
  onClose?: (sessionId: string) => Promise<void>;
  permissionModes?: PermissionModeRegistry;
  trace?: TraceRecorder;
}

export class SessionRuntime {
  readonly sessionId: string;
  readonly lifecycle: SessionLifecycleController;
  private readonly inbox = new CommandInbox();
  private readonly ledger = new InputLedger();
  private readonly loop: AgentLoop;
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly logEpoch: string;
  private readonly events: EventLog;
  private readonly sessionStore?: SessionStore;
  private readonly sessionTree: SessionTree;
  private readonly taskGraph: TaskGraph;
  private readonly systemPrompt: string;
  private readonly permissionModes: PermissionModeRegistry;
  private readonly queue: QueueItem[] = [];
  private readonly rows: ConversationRow[] = [];
  private readonly messages: ModelMessage[] = [];
  private readonly listeners = new Set<(projection: ProductProjection) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly children = new Map<string, ChildTaskProjection>();
  private status: TaskStatus = 'completed';
  private revision = 0;
  private eventSeq = 0;
  private activeTaskId?: string;
  private lastError?: StructuredError;
  private running = false;
  private abort?: AbortController;
  private persistTail: Promise<void> = Promise.resolve();
  private persistenceError?: StructuredError;
  private readonly overflowRetries = new Set<string>();
  private readonly toolSpans = new Map<string, string>();

  constructor(private readonly options: SessionRuntimeOptions) {
    this.sessionId = options.sessionId;
    this.clock = options.clock;
    this.ids = options.ids;
    this.logEpoch =
      options.initialSnapshot?.logEpoch ?? options.logEpoch ?? this.ids.next('epoch');
    this.events = new EventLog(this.logEpoch, () => this.clock.now());
    this.sessionStore = options.sessionStore;
    this.permissionModes =
      options.permissionModes ?? new PermissionModeRegistry('guarded', () => this.clock.now());
    this.sessionTree = new SessionTree({
      entries: options.initialSnapshot?.sessionEntries ?? [],
      activeLeafId: options.initialSnapshot?.activeLeafId ?? null,
      now: () => this.clock.now(),
    });
    this.taskGraph = new TaskGraph(
      () => this.clock.now(),
      options.initialSnapshot?.tasks ?? []
    );
    this.systemPrompt =
      options.systemPrompt ??
      (options.initialSnapshot?.messages.find((message) => message.role === 'system')?.content as
        | string
        | undefined) ??
      '';
    this.lifecycle = new SessionLifecycleController(
      options.sessionId,
      options.clock,
      () => this.touch('lifecycle.changed')
    );
    this.loop = new AgentLoop({
      model: options.model,
      tools: options.tools,
      ids: options.ids,
      maxSteps: options.maxSteps,
    });
    if (this.systemPrompt) this.messages.push({ role: 'system', content: this.systemPrompt });
    if (options.initialSnapshot) this.restore(options.initialSnapshot);
  }

  async ensureReady(): Promise<void> {
    await this.lifecycle.ensureReady(async () => {
      if (this.options.onOpen) await this.options.onOpen(this.sessionId);
    });
  }

  async command(command: CommandEnvelope): Promise<CommandAck> {
    const result = await this.inbox.submit(command, async (current) => {
      if (current.sessionId !== this.sessionId) {
        return this.ack(current, 'rejected', 'SESSION_MISMATCH', 'Command session does not match');
      }
      if (this.lifecycle.getState().state !== 'ready') {
        return this.ack(current, 'rejected', 'SESSION_NOT_READY', 'Session is not ready');
      }
      if (current.baseRevision !== undefined && current.baseRevision !== this.revision) {
        return this.ack(
          current,
          'stale',
          'COMMAND_STALE',
          `Expected revision ${this.revision}, received ${current.baseRevision}`
        );
      }
      if (current.type === 'send_input') return this.sendInput(current);
      if (current.type === 'stop') return this.stop(current);
      if (current.type === 'set_mode') return this.setPermissionMode(current);
      if (current.type === 'submit_plan') return this.submitPlan(current);
      if (current.type === 'approve_plan') return this.approvePlan(current);
      if (current.type === 'compact') return this.compact(current);
      return this.ack(current, 'rejected', 'COMMAND_UNSUPPORTED', 'Unsupported command');
    });
    if (this.sessionStore) {
      this.schedulePersist();
      await this.flushPersistence();
    }
    return result;
  }

  queryCommand(commandId: string): CommandAck | undefined {
    return this.inbox.query(commandId);
  }

  ownsTask(taskId: string): boolean {
    return Boolean(this.taskGraph.get(taskId));
  }

  contextMessages(): ModelMessage[] {
    return buildModelContext(this.sessionTree, this.systemPrompt);
  }

  updateChildTask(parentTaskId: string, child: ChildTaskProjection): boolean {
    if (
      !this.taskGraph.get(parentTaskId) &&
      !this.rows.some((row) => row.productTurnId === parentTaskId)
    ) {
      return false;
    }
    this.children.set(child.taskId, { ...child });
    this.touch('child_task.updated');
    return true;
  }

  view(): SessionView {
    const mode = this.permissionModes.get(this.sessionId).getState();
    return {
      sessionId: this.sessionId,
      lifecycle: this.lifecycle.getState().state,
      taskStatus: this.status,
      revision: this.revision,
      eventSeq: this.eventSeq,
      logEpoch: this.logEpoch,
      queueLength: this.queue.length,
      ...(this.activeTaskId ? { activeTaskId: this.activeTaskId } : {}),
      ...(this.lastError ? { lastError: { ...this.lastError } } : {}),
      permissionMode: mode.mode,
      ...(mode.plan || mode.approvedAt
        ? {
            plan: {
              ...(mode.plan ? { text: mode.plan } : {}),
              ...(mode.approvedAt ? { approvedAt: mode.approvedAt } : {}),
              ...(mode.approvedDigest ? { approvedDigest: mode.approvedDigest } : {}),
            },
          }
        : {}),
      ...(this.children.size
        ? { children: [...this.children.values()].map((child) => ({ ...child })) }
        : {}),
      rows: this.rows.map((row) => ({ ...row })),
      pendingApproval: false,
      ledger: this.ledger.list(),
    };
  }

  projection(): ProductProjection {
    return buildProjection(this.view());
  }

  eventLog(): RuntimeEvent[] {
    return this.events.list();
  }

  async flushPersistence(): Promise<void> {
    await this.persistTail;
    if (this.persistenceError) {
      throw new AgentError(
        this.persistenceError.code,
        this.persistenceError.message,
        { retryable: this.persistenceError.retryable }
      );
    }
  }

  subscribe(listener: (projection: ProductProjection) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async waitForIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  async stopInstance(): Promise<void> {
    await this.lifecycle.stop(async () => {
      this.abort?.abort();
      this.cancelQueued('session_stopped');
      await this.waitForIdle();
      await this.options.onClose?.(this.sessionId);
    });
  }

  async restartInstance(): Promise<void> {
    await this.lifecycle.restart(
      async () => {
        this.abort?.abort();
        this.cancelQueued('session_restart');
        await this.waitForIdle();
        await this.options.onClose?.(this.sessionId);
      },
      async () => {
        if (this.options.onOpen) await this.options.onOpen(this.sessionId);
      }
    );
  }

  private async sendInput(command: CommandEnvelope): Promise<CommandAck> {
    const payload = command.payload as SendInputPayload;
    const text = typeof payload?.text === 'string' ? payload.text.trim() : '';
    if (!text) return this.ack(command, 'rejected', 'INPUT_EMPTY', 'Input text cannot be empty');
    const modelText = composeUserInput(text, payload.context);
    if (payload.delivery === 'guide' && this.running && this.activeTaskId) {
      return this.guideInput(command, text, modelText);
    }

    const inputId = this.ids.next('input');
    const taskId = this.ids.next('task');
    this.taskGraph.create({
      taskId,
      sessionId: this.sessionId,
      budget: {},
    });
    this.ledger.admit({
      inputId,
      sourceCommandId: command.commandId,
      text,
      delivery: payload.delivery ?? (this.activeTaskId ? 'queue' : 'startNow'),
      admittedAt: this.clock.now(),
    });
    this.rows.push({
      id: this.ids.next('row'),
      entityId: inputId,
      productTurnId: taskId,
      kind: 'user',
      text,
      status: 'pending',
    });
    this.queue.push({ inputId, commandId: command.commandId, taskId, text, modelText });
    if (!this.activeTaskId) {
      this.activeTaskId = taskId;
      this.status = 'queued';
    }
    this.touch('input.admitted');
    try {
      await this.flushPersistence();
    } catch (error) {
      this.ledger.fail(inputId, 'persistence_failed');
      this.status = 'failed';
      this.lastError = toStructuredError(error, 'PERSISTENCE_FAILED');
      const row = this.rows.find((candidate) => candidate.entityId === inputId);
      if (row) row.status = 'failed';
      this.touch('persistence.failed');
      return this.ack(
        command,
        'failed',
        'PERSISTENCE_FAILED',
        this.lastError.message
      );
    }
    const ack = this.ack(command, 'accepted', undefined, undefined, inputId, taskId);
    queueMicrotask(() => void this.pump());
    return ack;
  }

  private async guideInput(
    command: CommandEnvelope,
    text: string,
    modelText: string
  ): Promise<CommandAck> {
    const inputId = this.ids.next('input');
    this.ledger.admit({
      inputId,
      sourceCommandId: command.commandId,
      text,
      delivery: 'guide',
      admittedAt: this.clock.now(),
    });
    this.rows.push({
      id: this.ids.next('row'),
      entityId: inputId,
      productTurnId: this.activeTaskId!,
      kind: 'user',
      text,
      status: 'completed',
    });
    this.sessionTree.append({
      type: 'message',
      payload: { role: 'user', content: modelText } as unknown as import('./types').JsonValue,
    });
    this.loop.steer(modelText);
    this.ledger.promote(inputId);
    this.touch('input.steered');
    try {
      await this.flushPersistence();
    } catch (error) {
      this.lastError = toStructuredError(error, 'PERSISTENCE_FAILED');
      return this.ack(command, 'failed', 'PERSISTENCE_FAILED', this.lastError.message, inputId);
    }
    return this.ack(command, 'accepted', undefined, undefined, inputId, this.activeTaskId);
  }

  private setPermissionMode(command: CommandEnvelope): CommandAck {
    const payload = command.payload as SetModePayload;
    const allowed: PermissionMode[] = ['plan', 'build', 'edit', 'guarded', 'sandbox-auto'];
    if (!allowed.includes(payload?.mode)) {
      return this.ack(command, 'rejected', 'PERMISSION_MODE_INVALID', 'Unknown permission mode');
    }
    try {
      this.permissionModes.get(this.sessionId).setMode(payload.mode);
    } catch (error) {
      return this.ack(
        command,
        'rejected',
        error instanceof AgentError ? error.code : 'PERMISSION_MODE_REJECTED',
        error instanceof Error ? error.message : String(error)
      );
    }
    this.touch('permission_mode.changed');
    return this.ack(command, 'accepted');
  }

  private async submitPlan(command: CommandEnvelope): Promise<CommandAck> {
    const payload = command.payload as PlanPayload;
    try {
      await this.permissionModes.get(this.sessionId).submitPlan(String(payload?.plan ?? ''));
    } catch (error) {
      return this.ack(
        command,
        'rejected',
        error instanceof AgentError ? error.code : 'PLAN_REJECTED',
        error instanceof Error ? error.message : String(error)
      );
    }
    this.touch('plan.submitted');
    return this.ack(command, 'accepted');
  }

  private approvePlan(command: CommandEnvelope): CommandAck {
    try {
      this.permissionModes.get(this.sessionId).approvePlan();
    } catch (error) {
      return this.ack(
        command,
        'rejected',
        error instanceof AgentError ? error.code : 'PLAN_APPROVAL_REJECTED',
        error instanceof Error ? error.message : String(error)
      );
    }
    this.touch('plan.approved');
    return this.ack(command, 'accepted');
  }

  private async compact(command: CommandEnvelope): Promise<CommandAck> {
    if (this.running || this.queue.length > 0) {
      return this.ack(command, 'rejected', 'SESSION_BUSY', 'Cannot compact while a task is running');
    }
    const payload = command.payload as CompactPayload;
    const budget = payload.budget ?? {
      contextWindow: 16_000,
      reserveTokens: 2_000,
      keepRecentTokens: 4_000,
      maxOutputTokens: 2_000,
    };
    let summary = payload.summary?.trim() ?? '';
    if (!summary) {
      const transcript = buildModelContext(this.sessionTree, '')
        .map((message) => `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`)
        .join('\n\n');
      try {
        for await (const event of this.options.model.stream({
          sessionId: this.sessionId,
          taskId: this.ids.next('compaction_task'),
          messages: [
            {
              role: 'system',
              content:
                'Summarize this conversation for future work. Preserve decisions, facts, URLs, files, code changes, open tasks and verification evidence. Output only the summary.',
            },
            { role: 'user', content: transcript },
          ],
          tools: [],
          signal: new AbortController().signal,
        })) {
          if (event.type === 'text_delta') summary += event.text;
          if (event.type === 'error') throw new AgentError(event.error.code, event.error.message);
        }
      } catch (error) {
        return this.ack(
          command,
          'failed',
          'COMPACTION_SUMMARY_FAILED',
          error instanceof Error ? error.message : String(error)
        );
      }
    }
    try {
      appendCompaction(this.sessionTree, {
        summary,
        budget,
        details: payload.details,
      });
      this.messages.splice(
        0,
        this.messages.length,
        ...buildModelContext(this.sessionTree, this.systemPrompt)
      );
      const activityId = this.ids.next('activity');
      this.rows.push({
        id: activityId,
        entityId: activityId,
        productTurnId: 'session_compaction',
        kind: 'activity',
        text: 'Context compacted',
        status: 'completed',
      });
    } catch (error) {
      return this.ack(
        command,
        'rejected',
        error instanceof AgentError ? error.code : 'COMPACTION_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
    this.touch('session.compacted');
    return this.ack(command, 'accepted');
  }

  private async generateCompactionSummary(): Promise<string> {
    const transcript = buildModelContext(this.sessionTree, '')
      .map(
        (message) =>
          `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`
      )
      .join('\n\n');
    let summary = '';
    for await (const event of this.options.model.stream({
      sessionId: this.sessionId,
      taskId: this.ids.next('compaction_task'),
      messages: [
        {
          role: 'system',
          content:
            'Summarize this conversation for future work. Preserve decisions, facts, URLs, files, code changes, open tasks and verification evidence. Output only the summary.',
        },
        { role: 'user', content: transcript },
      ],
      tools: [],
      signal: new AbortController().signal,
    })) {
      if (event.type === 'text_delta') summary += event.text;
      if (event.type === 'error') throw new AgentError(event.error.code, event.error.message);
    }
    if (!summary.trim()) throw new AgentError('COMPACTION_SUMMARY_EMPTY', 'Summary was empty');
    return summary;
  }

  private isContextOverflow(error: StructuredError | undefined): boolean {
    if (!error) return false;
    return /context|token|length|too large|maximum/i.test(`${error.code} ${error.message}`);
  }

  private stop(command: CommandEnvelope): CommandAck {
    const idle = !this.running && this.queue.length === 0;
    if (idle) return this.ack(command, 'noop', 'TASK_NOT_ACTIVE', 'No task is active');
    this.abort?.abort();
    this.cancelQueued('user_stopped');
    this.touch('task.stop_requested');
    return this.ack(command, 'accepted');
  }

  private async pump(): Promise<void> {
    if (this.running || this.lifecycle.getState().state !== 'ready') return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        this.activeTaskId = item.taskId;
        this.status = this.status === 'queued' ? 'running' : this.status;
        if (this.status !== 'running') this.status = 'running';
        if (this.taskGraph.get(item.taskId)?.status === 'queued') {
          this.taskGraph.transition(item.taskId, 'running');
        }
        this.ledger.promote(item.inputId);
        this.messages.push({ role: 'user', content: item.modelText });
        this.sessionTree.append({
          type: 'message',
          payload: { role: 'user', content: item.modelText } as unknown as import('./types').JsonValue,
        });
        this.abort = new AbortController();
        const runSpan = this.options.trace?.start('agent.run', {
          sessionId: this.sessionId,
          taskId: item.taskId,
        });
        this.touch('task.started');

        let result = await this.loop.run({
          sessionId: this.sessionId,
          taskId: item.taskId,
          messages: buildModelContext(this.sessionTree, this.systemPrompt),
          signal: this.abort.signal,
          onEvent: (event) => this.onLoopEvent(item.taskId, event),
        });
        if (
          result.status === 'failed' &&
          this.isContextOverflow(result.error) &&
          !this.overflowRetries.has(item.taskId)
        ) {
          this.overflowRetries.add(item.taskId);
          try {
            const summary = await this.generateCompactionSummary();
            appendCompaction(this.sessionTree, {
              summary,
              budget: {
                contextWindow: 16_000,
                reserveTokens: 2_000,
                keepRecentTokens: 1,
                maxOutputTokens: 2_000,
              },
            });
            this.messages.splice(
              0,
              this.messages.length,
              ...buildModelContext(this.sessionTree, this.systemPrompt)
            );
            this.touch('context.overflow_retry');
            result = await this.loop.run({
              sessionId: this.sessionId,
              taskId: item.taskId,
              messages: buildModelContext(this.sessionTree, this.systemPrompt),
              signal: this.abort.signal,
              onEvent: (event) => this.onLoopEvent(item.taskId, event),
            });
          } catch {
            // Keep the original overflow error if recovery cannot produce a summary.
          }
        }
        this.messages.splice(0, this.messages.length, ...result.messages);
        if (result.status === 'completed') {
          this.status = 'completed';
          this.transitionTask(item.taskId, 'completed');
          this.lastError = undefined;
          this.setRowsForTask(item.taskId, 'completed');
        } else if (result.status === 'cancelled') {
          this.status = 'cancelled';
          this.transitionTask(item.taskId, 'cancelled');
          this.lastError = result.error;
          this.setRowsForTask(item.taskId, 'cancelled');
          this.cancelQueued('task_cancelled');
        } else {
          this.status = 'failed';
          this.transitionTask(item.taskId, 'failed');
          this.lastError = result.error;
          this.setRowsForTask(item.taskId, 'failed');
          this.cancelQueued('task_failed');
        }
        if (runSpan) {
          this.options.trace?.end(runSpan.spanId, { status: result.status }, result.error);
        }
        this.activeTaskId = undefined;
        this.abort = undefined;
        this.touch('task.finished');

        if (this.queue.length > 0 && result.status === 'completed') {
          this.activeTaskId = this.queue[0].taskId;
          this.status = 'queued';
          this.touch('queue.changed');
        }
      }
    } catch (error) {
      this.status = isAbortError(error) ? 'cancelled' : 'failed';
      this.activeTaskId = undefined;
      this.cancelQueued('runtime_failed');
      this.touch('runtime.failed');
    } finally {
      this.running = false;
      this.abort = undefined;
      this.notifyIdle();
      this.emit();
    }
  }

  private async onLoopEvent(taskId: string, event: AgentLoopEvent): Promise<void> {
    if (event.type === 'turn_start') {
      this.rows.push({
        id: `activity_${taskId}_${event.turn}`,
        entityId: `activity_${taskId}_${event.turn}`,
        productTurnId: taskId,
        kind: 'activity',
        text: 'Thinking',
        status: 'streaming',
      });
      this.taskGraph.recordUsage(taskId, { turns: 1 });
      this.touch(event.type);
    } else if (event.type === 'message_start') {
      this.rows.push({
        id: event.messageId,
        entityId: event.messageId,
        productTurnId: taskId,
        kind: 'assistant',
        text: '',
        status: 'streaming',
      });
      this.touch('message.started');
    } else if (event.type === 'message_update') {
      const row = this.rows.find((candidate) => candidate.id === event.messageId);
      if (row) row.text += event.delta;
      this.touch('message.delta');
    } else if (event.type === 'message_end') {
      const row = this.rows.find((candidate) => candidate.id === event.messageId);
      if (row) {
        row.text = event.message.role === 'assistant' ? event.message.content : row.text;
        row.status = 'completed';
      }
      if (event.message.role === 'assistant') {
        this.sessionTree.append({
          type: 'message',
          payload: {
            role: 'assistant',
            content: event.message.content,
            ...(event.message.toolCalls
              ? {
                  toolCallIds: event.message.toolCalls.map((call) => call.id),
                  toolCalls: event.message.toolCalls.map((call) => ({ ...call })),
                }
              : {}),
          } as unknown as import('./types').JsonValue,
        });
      }
      this.touch('message.finished');
    } else if (event.type === 'turn_end') {
      const activity = this.rows.find(
        (row) => row.id === `activity_${taskId}_${event.turn}`
      );
      if (activity) {
        activity.text = 'Thinking complete';
        activity.status = 'completed';
      }
      this.touch(event.type);
    } else if (event.type === 'tool_execution_start') {
      this.taskGraph.recordUsage(taskId, { toolCalls: 1 });
      const span = this.options.trace?.start('tool.call', {
        taskId,
        callId: event.result.callId,
        toolName: event.result.name,
      });
      if (span) this.toolSpans.set(event.result.callId, span.spanId);
      this.rows.push({
        id: `row_${event.result.callId}`,
        entityId: event.result.callId,
        productTurnId: taskId,
        kind: 'tool',
        text: '',
        status: 'pending',
        callId: event.result.callId,
        toolName: event.result.name,
      });
      this.touch('tool.started');
    } else if (event.type === 'tool_execution_end') {
      const row = this.rows.find((candidate) => candidate.callId === event.result.callId);
      if (row) {
        row.status =
          event.result.status === 'succeeded'
            ? 'completed'
            : event.result.status === 'denied'
              ? 'denied'
              : 'failed';
        row.text =
          event.result.status === 'succeeded'
            ? typeof event.result.output === 'string'
              ? event.result.output
              : JSON.stringify(event.result.output ?? null)
            : event.result.error?.message ?? 'Tool failed';
      }
      this.sessionTree.append({
        type: 'message',
        payload: {
          role: 'tool',
          toolCallId: event.result.callId,
          toolName: event.result.name,
          content: toolResultText(event.result),
        } as unknown as import('./types').JsonValue,
      });
      const spanId = this.toolSpans.get(event.result.callId);
      if (spanId) {
        this.options.trace?.end(
          spanId,
          { status: event.result.status },
          event.result.error
        );
        this.toolSpans.delete(event.result.callId);
      }
      this.touch('tool.finished');
    } else {
      if (event.type === 'run_end') {
        // Task status is finalized by pump after the loop returns.
      }
      this.touch(event.type);
    }
  }

  private setRowsForTask(taskId: string, status: ConversationRow['status']): void {
    for (const row of this.rows) {
      if (
        row.productTurnId === taskId &&
        (row.status === 'pending' || row.status === 'streaming')
      ) {
        row.status = status;
      }
    }
  }

  private cancelQueued(reason: string): void {
    for (const item of this.queue.splice(0)) {
      this.taskGraph.cancelTree(item.taskId, reason);
      this.ledger.cancel(item.inputId, reason);
      const row = this.rows.find((candidate) => candidate.entityId === item.inputId);
      if (row) row.status = 'cancelled';
    }
  }

  private ack(
    command: CommandEnvelope,
    status: CommandAck['status'],
    code?: string,
    message?: string,
    inputId?: string,
    taskId?: string
  ): CommandAck {
    return {
      commandId: command.commandId,
      sessionId: this.sessionId,
      status,
      revision: this.revision,
      ...(inputId ? { inputId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(code
        ? {
            error: {
              code,
              message: message ?? code,
              retryable: false,
            },
          }
        : {}),
    };
  }

  private touch(type: string): void {
    this.revision += 1;
    this.events.append(type, this.revision);
    this.eventSeq = this.events.seq;
    this.emit();
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (!this.sessionStore) return;
    const snapshot = this.snapshot();
    this.persistTail = this.persistTail.then(async () => {
      try {
        await this.sessionStore!.save(snapshot);
        this.persistenceError = undefined;
      } catch (error) {
        this.persistenceError = toStructuredError(error, 'PERSISTENCE_FAILED');
      }
    });
  }

  private snapshot(): SessionSnapshot {
    return cloneSnapshot({
      schemaVersion: 1,
      sessionId: this.sessionId,
      logEpoch: this.logEpoch,
      revision: this.revision,
      eventSeq: this.eventSeq,
      taskStatus: this.status,
      messages: this.messages,
      rows: this.rows,
      ledger: this.ledger.list(),
      events: this.events.list(),
      commands: this.inbox.snapshot(),
      sessionEntries: this.sessionTree.rawEntries(),
      activeLeafId: this.sessionTree.activeLeaf,
      tasks: this.taskGraph.list(),
      permission: this.permissionModes.get(this.sessionId).getState(),
    });
  }

  private restore(snapshot: SessionSnapshot): void {
    this.messages.splice(0, this.messages.length, ...cloneMessages(snapshot.messages));
    this.rows.splice(0, this.rows.length, ...snapshot.rows.map((row) => ({ ...row })));
    this.ledger.restore(snapshot.ledger);
    this.events.restore(snapshot.events);
    this.inbox.restore(snapshot.commands ?? []);
    if (snapshot.permission) {
      this.permissionModes.restore(this.sessionId, snapshot.permission);
    }
    this.revision = snapshot.revision;
    this.eventSeq = snapshot.eventSeq;
    this.status = snapshot.taskStatus;
    if (!snapshot.sessionEntries?.length && this.messages.length) {
      for (const message of this.messages) {
        if (message.role === 'system') continue;
        this.sessionTree.append({
          type: 'message',
          payload: messagePayload(message) as unknown as import('./types').JsonValue,
        });
      }
    }

    let reconciled = false;
    if (this.status === 'queued' || this.status === 'running' || this.status === 'waiting') {
      this.status = 'cancelled';
      reconciled = true;
    }
    for (const task of this.taskGraph.list()) {
      if (task.status === 'queued' || task.status === 'running' || task.status === 'waiting') {
        this.taskGraph.cancelTree(task.taskId, 'session_resumed');
        reconciled = true;
      }
    }
    for (const entry of this.ledger.list()) {
      if (entry.status === 'admitted') {
        this.ledger.discard(entry.inputId, 'session_resumed');
        reconciled = true;
      }
    }
    for (const row of this.rows) {
      if (row.status === 'pending' || row.status === 'streaming') {
        row.status = 'cancelled';
        reconciled = true;
      }
    }
    if (reconciled) this.touch('session.reconciled');
  }

  private emit(): void {
    const projection = this.projection();
    for (const listener of this.listeners) listener(projection);
  }

  private transitionTask(taskId: string, status: TaskStatus): void {
    const task = this.taskGraph.get(taskId);
    if (task && !['completed', 'failed', 'cancelled'].includes(task.status)) {
      this.taskGraph.transition(taskId, status);
    }
  }

  private notifyIdle(): void {
    if (this.running || this.queue.length > 0) return;
    const waiters = [...this.idleWaiters];
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }
}

function cloneMessages(messages: readonly ModelMessage[]): ModelMessage[] {
  return messages.map((message) =>
    message.role === 'assistant' && message.toolCalls
      ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) }
      : { ...message }
  );
}

function messagePayload(message: ModelMessage): SessionMessagePayload {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls
        ? {
            toolCallIds: message.toolCalls.map((call) => call.id),
            toolCalls: message.toolCalls.map((call) => ({ ...call })),
          }
        : {}),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      toolCallId: message.callId,
      toolName: message.name,
    };
  }
  return { role: message.role, content: message.content };
}

function composeUserInput(
  text: string,
  context: SendInputPayload['context']
): string {
  const blocks = [text];
  if (context?.skill) {
    blocks.push(
      `User activated skill "${context.skill.name}".\n<skill-loaded name="${context.skill.name}" source="ui">\n${context.skill.instructions}\n</skill-loaded>`
    );
  }
  if (context?.attachments?.length) {
    const lines = context.attachments.map((attachment) => {
      const header = `- ${attachment.name} (${attachment.type})`;
      return attachment.text
        ? `${header}\n<attachment name="${attachment.name}">\n${attachment.text}\n</attachment>`
        : `${header}${attachment.dataBase64 ? ' [image/binary omitted from text-only model input]' : ''}`;
    });
    blocks.push(`<attachments>\n${lines.join('\n')}\n</attachments>`);
  }
  return blocks.filter(Boolean).join('\n\n');
}
