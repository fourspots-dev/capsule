import {
  AgentProfileRegistry,
  type ChildTaskSpec,
  type PermissionPolicy,
  type ResolvedAgentProfile,
  type TaskBudget,
} from './agent-profile';
import { AgentError } from './errors';
import { validateJsonValue } from './tool-schema';
import type { ProductProjection, StructuredError } from './types';
import type { ModelMessage } from './types';

export type ChildTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ChildResult {
  status: 'completed' | 'failed' | 'cancelled';
  summary: string;
  output?: unknown;
  findings?: Array<{ claim: string; evidence: string[] }>;
  artifacts: string[];
  changedFiles?: string[];
  patch?: string;
  testResults?: unknown;
  unresolved: string[];
  error?: StructuredError;
}

export interface ChildTaskRecord {
  taskId: string;
  sessionId: string;
  parentTaskId: string;
  profileName: string;
  brief: string;
  contextMode: ChildTaskSpec['contextMode'];
  executionMode: ChildTaskSpec['executionMode'];
  budget: TaskBudget;
  status: ChildTaskStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  result?: ChildResult;
}

export interface ChildDriver {
  create(request: {
    taskId: string;
    spec: ChildTaskSpec;
    profile: ResolvedAgentProfile;
    prompt: string;
  }): Promise<{ sessionId: string }>;
  run(taskId: string, signal: AbortSignal): Promise<ChildResult>;
  send(taskId: string, message: string, delivery: 'guide' | 'queue'): Promise<void>;
  stop(taskId: string): Promise<void>;
  projection(taskId: string): ProductProjection | undefined;
  resume?(taskId: string, message: string): Promise<ChildResult>;
  dispose?(): Promise<void>;
}

export interface ParentTaskContext {
  taskId: string;
  depth: number;
  maxDepth: number;
  permissions: PermissionPolicy;
  concurrency?: number;
}

export interface SubagentCoordinatorOptions {
  registry: AgentProfileRegistry;
  driver: ChildDriver;
  ids: { next(prefix: string): string };
  now?: () => number;
  contextProvider?: (parentTaskId: string) => Promise<ModelMessage[]>;
}

type ChildListener = (record: Readonly<ChildTaskRecord>) => void;

export class SubagentCoordinator {
  private readonly tasks = new Map<string, ChildTaskRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly profiles = new Map<string, ResolvedAgentProfile>();
  private readonly waits = new Map<string, Promise<ChildResult>>();
  private readonly listeners = new Set<ChildListener>();

  constructor(private readonly options: SubagentCoordinatorOptions) {}

  async spawn(spec: ChildTaskSpec, parent: ParentTaskContext): Promise<ChildTaskRecord> {
    const profile = this.options.registry.resolve(spec.profile, parent.permissions);
    this.options.registry.validateChild(spec, {
      depth: parent.depth,
      maxDepth: parent.maxDepth,
      concurrency: parent.concurrency ?? this.runningChildren(spec.parentTaskId),
    });
    const taskId = this.options.ids.next('child_task');
    const normalized = {
      ...spec,
      parentTaskId: spec.parentTaskId || parent.taskId,
      contextRefs: [...(spec.contextRefs ?? [])],
      budget: { ...spec.budget },
    };
    const created = await this.options.driver.create({
      taskId,
      spec: normalized,
      profile,
      prompt: childPrompt(
        normalized,
        normalized.contextMode === 'fork'
          ? await this.forkContext(normalized.parentTaskId)
          : undefined
      ),
    });
    const record: ChildTaskRecord = {
      taskId,
      sessionId: created.sessionId,
      parentTaskId: normalized.parentTaskId,
      profileName: profile.name,
      brief: normalized.brief,
      contextMode: normalized.contextMode,
      executionMode: normalized.executionMode,
      budget: normalized.budget,
      status: 'queued',
      createdAt: this.now(),
    };
    this.tasks.set(taskId, record);
    this.profiles.set(taskId, profile);
    this.emit(record);
    const completion = this.run(record);
    this.waits.set(taskId, completion);
    if (normalized.executionMode === 'foreground' || normalized.executionMode === 'isolated-worktree') {
      await completion;
      return this.read(record.taskId)!;
    }
    return this.read(record.taskId)!;
  }

  async wait(taskId: string): Promise<ChildResult> {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentError('CHILD_NOT_FOUND', `Child task not found: ${taskId}`);
    if (task.result) return structuredClone(task.result);
    const pending = this.waits.get(taskId);
    if (!pending) {
      throw new AgentError('CHILD_NOT_RUNNING', `Child task is not running: ${taskId}`);
    }
    return completionCopy(await pending);
  }

  async send(taskId: string, message: string, delivery: 'guide' | 'queue' = 'queue'): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentError('CHILD_NOT_FOUND', `Child task not found: ${taskId}`);
    if (task.status === 'running' || task.status === 'queued') {
      await this.options.driver.send(taskId, message, delivery);
      return;
    }
    if (!this.options.driver.resume) {
      throw new AgentError('CHILD_TERMINAL', `Child task is terminal: ${taskId}`);
    }
    task.status = 'queued';
    task.startedAt = this.now();
    task.completedAt = undefined;
    task.result = undefined;
    this.emit(task);
    const result = await this.options.driver.resume(taskId, message);
    this.finish(task, result);
  }

  async stop(taskId: string, recursive = true): Promise<void> {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (recursive) {
      for (const child of this.tasks.values()) {
        if (child.parentTaskId === taskId) await this.stop(child.taskId, true);
      }
    }
    if (!isTerminal(task.status)) {
      this.controllers.get(taskId)?.abort();
      await this.options.driver.stop(taskId);
      const cancelled: ChildResult = {
        status: 'cancelled',
        summary: 'Cancelled by parent',
        artifacts: [],
        unresolved: [],
      };
      this.finish(task, cancelled);
    }
  }

  list(parentTaskId?: string): ChildTaskRecord[] {
    return [...this.tasks.values()]
      .filter((task) => parentTaskId === undefined || task.parentTaskId === parentTaskId)
      .map((task) => structuredClone(task));
  }

  get(taskId: string): ChildTaskRecord | undefined {
    return this.read(taskId);
  }

  subscribe(listener: ChildListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.tasks.keys()].map((taskId) => this.stop(taskId, false)));
    await this.options.driver.dispose?.();
    this.listeners.clear();
    this.profiles.clear();
  }

  private run(task: ChildTaskRecord): Promise<ChildResult> {
    const controller = new AbortController();
    this.controllers.set(task.taskId, controller);
    task.status = 'running';
    task.startedAt = this.now();
    this.emit(task);
    return this.options.driver
      .run(task.taskId, controller.signal)
      .then((result) => {
        const profile = this.profiles.get(task.taskId);
        if (profile?.resultSchema) {
          try {
            validateJsonValue(profile.resultSchema, result.output ?? result.summary, 'result');
          } catch (error) {
            const invalid: ChildResult = {
              ...result,
              status: 'failed',
              summary: 'Child result failed schema validation',
              unresolved: [
                ...result.unresolved,
                error instanceof Error ? error.message : String(error),
              ],
              error: {
                code: 'CHILD_RESULT_SCHEMA_INVALID',
                message: error instanceof Error ? error.message : String(error),
                retryable: false,
              },
            };
            this.finish(task, invalid);
            return completionCopy(invalid);
          }
        }
        this.finish(task, result);
        return completionCopy(result);
      })
      .catch((error) => {
        const result: ChildResult = {
          status: controller.signal.aborted ? 'cancelled' : 'failed',
          summary: controller.signal.aborted ? 'Cancelled' : 'Child task failed',
          artifacts: [],
          unresolved: [],
          error: {
            code: controller.signal.aborted ? 'CHILD_CANCELLED' : 'CHILD_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          },
        };
        this.finish(task, result);
        return completionCopy(result);
      })
      .finally(() => this.controllers.delete(task.taskId));
  }

  private finish(task: ChildTaskRecord, result: ChildResult): void {
    if (isTerminal(task.status)) return;
    task.status = result.status;
    task.completedAt = this.now();
    task.result = completionCopy(result);
    this.emit(task);
  }

  private emit(task: ChildTaskRecord): void {
    const snapshot = structuredClone(task);
    for (const listener of this.listeners) listener(snapshot);
  }

  private read(taskId: string): ChildTaskRecord | undefined {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : undefined;
  }

  private runningChildren(parentTaskId: string): number {
    return [...this.tasks.values()].filter(
      (task) =>
        task.parentTaskId === parentTaskId &&
        (task.status === 'queued' || task.status === 'running')
    ).length;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private async forkContext(parentTaskId: string): Promise<ModelMessage[]> {
    if (!this.options.contextProvider) {
      throw new AgentError(
        'CHILD_CONTEXT_UNAVAILABLE',
        'Fork context was requested but no parent context provider is available'
      );
    }
    return this.options.contextProvider(parentTaskId);
  }
}

function childPrompt(spec: ChildTaskSpec, inherited: ModelMessage[] = []): string {
  const lines = [
    'Complete this delegated task independently.',
    '',
    spec.brief,
    '',
    'Return a structured result with a concise summary, evidence, artifacts, unresolved items, and changed files when applicable.',
  ];
  if (spec.acceptance?.length) {
    lines.push('', 'Acceptance criteria:', ...spec.acceptance.map((item) => `- ${item}`));
  }
  if (spec.contextMode === 'artifacts' && spec.contextRefs?.length) {
    lines.push('', 'Available context artifact references:', ...spec.contextRefs.map((item) => `- ${item}`));
  }
  if (spec.contextMode === 'fresh') {
    lines.push('', 'You do not receive the parent conversation. Ask only if the brief is insufficient.');
  } else if (spec.contextMode === 'fork' && inherited.length) {
    lines.push('', 'Inherited parent conversation (read-only context):');
    for (const message of inherited) {
      lines.push(
        `${message.role}: ${typeof message.content === 'string' ? message.content : JSON.stringify(message.content)}`
      );
    }
  }
  return lines.join('\n');
}

function completionCopy(result: ChildResult): ChildResult {
  return structuredClone(result);
}

function isTerminal(status: ChildTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
