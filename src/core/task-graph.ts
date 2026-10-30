import { AgentError } from './errors';
import type { TaskBudget } from './agent-profile';
import { canTransitionTask, isTerminalTaskStatus } from './state-machines';
import type { JsonValue, TaskStatus } from './types';

export interface TaskUsage {
  turns: number;
  toolCalls: number;
  tokens: number;
  startedAt?: number;
}

export interface TaskLease {
  ownerId: string;
  fencingToken: number;
  expiresAt: number;
}

export interface TaskNode {
  taskId: string;
  sessionId: string;
  parentTaskId?: string;
  status: TaskStatus;
  revision: number;
  budget: TaskBudget;
  usage: TaskUsage;
  lease?: TaskLease;
  checkpoint?: JsonValue;
  children: string[];
  createdAt: number;
  updatedAt: number;
}

export class TaskGraph {
  private readonly tasks = new Map<string, TaskNode>();
  private sequence = 0;

  constructor(
    private readonly now: () => number = () => Date.now(),
    initial: readonly TaskNode[] = []
  ) {
    for (const task of initial) this.tasks.set(task.taskId, cloneTask(task));
  }

  create(request: {
    taskId: string;
    sessionId: string;
    parentTaskId?: string;
    budget?: TaskBudget;
  }): TaskNode {
    if (this.tasks.has(request.taskId)) {
      throw new AgentError('TASK_DUPLICATE', `Task already exists: ${request.taskId}`);
    }
    if (request.parentTaskId && !this.tasks.has(request.parentTaskId)) {
      throw new AgentError('TASK_PARENT_NOT_FOUND', `Parent task not found: ${request.parentTaskId}`);
    }
    const now = this.now();
    const task: TaskNode = {
      taskId: request.taskId,
      sessionId: request.sessionId,
      ...(request.parentTaskId ? { parentTaskId: request.parentTaskId } : {}),
      status: 'queued',
      revision: 1,
      budget: { ...(request.budget ?? {}) },
      usage: { turns: 0, toolCalls: 0, tokens: 0 },
      children: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.taskId, task);
    if (task.parentTaskId) {
      const parent = this.tasks.get(task.parentTaskId)!;
      parent.children.push(task.taskId);
      parent.revision += 1;
      parent.updatedAt = now;
    }
    return cloneTask(task);
  }

  get(taskId: string): TaskNode | undefined {
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : undefined;
  }

  transition(taskId: string, next: TaskStatus, checkpoint?: JsonValue): TaskNode {
    const task = this.required(taskId);
    if (!canTransitionTask(task.status, next)) {
      throw new AgentError(
        'TASK_TRANSITION_INVALID',
        `Invalid task transition: ${task.status} -> ${next}`
      );
    }
    task.status = next;
    task.revision += 1;
    task.updatedAt = this.now();
    if (checkpoint !== undefined) task.checkpoint = structuredClone(checkpoint);
    return cloneTask(task);
  }

  claimLease(
    taskId: string,
    ownerId: string,
    ttlMs: number
  ): TaskLease {
    const task = this.required(taskId);
    if (isTerminalTaskStatus(task.status)) {
      throw new AgentError('TASK_TERMINAL', `Cannot lease terminal task: ${taskId}`);
    }
    if (task.lease && task.lease.expiresAt > this.now() && task.lease.ownerId !== ownerId) {
      throw new AgentError(
        'TASK_LEASE_HELD',
        `Task lease is held by ${task.lease.ownerId} until ${task.lease.expiresAt}`
      );
    }
    task.lease = {
      ownerId,
      fencingToken: ++this.sequence,
      expiresAt: this.now() + ttlMs,
    };
    task.revision += 1;
    task.updatedAt = this.now();
    return { ...task.lease };
  }

  renewLease(taskId: string, fencingToken: number, ttlMs: number): TaskLease {
    const task = this.required(taskId);
    this.assertFence(task, fencingToken);
    task.lease = {
      ...task.lease!,
      expiresAt: this.now() + ttlMs,
    };
    task.revision += 1;
    task.updatedAt = this.now();
    return { ...task.lease };
  }

  releaseLease(taskId: string, fencingToken: number): void {
    const task = this.required(taskId);
    this.assertFence(task, fencingToken);
    delete task.lease;
    task.revision += 1;
    task.updatedAt = this.now();
  }

  assertWrite(taskId: string, fencingToken: number): void {
    const task = this.required(taskId);
    this.assertFence(task, fencingToken);
  }

  recordUsage(
    taskId: string,
    delta: Partial<Omit<TaskUsage, 'startedAt'>>
  ): TaskNode {
    const task = this.required(taskId);
    task.usage = {
      ...task.usage,
      turns: task.usage.turns + (delta.turns ?? 0),
      toolCalls: task.usage.toolCalls + (delta.toolCalls ?? 0),
      tokens: task.usage.tokens + (delta.tokens ?? 0),
      ...(task.usage.startedAt === undefined ? { startedAt: this.now() } : {}),
    };
    task.revision += 1;
    task.updatedAt = this.now();
    if (this.budgetExceeded(task) && !isTerminalTaskStatus(task.status)) {
      task.status = 'paused';
    }
    return cloneTask(task);
  }

  cancelTree(taskId: string, reason = 'cancelled'): string[] {
    const task = this.required(taskId);
    const cancelled: string[] = [];
    const visit = (current: TaskNode): void => {
      for (const childId of current.children) {
        const child = this.tasks.get(childId);
        if (child) visit(child);
      }
      if (!isTerminalTaskStatus(current.status)) {
        current.status = 'cancelled';
        current.revision += 1;
        current.updatedAt = this.now();
        current.checkpoint = { reason };
        cancelled.push(current.taskId);
      }
    };
    visit(task);
    return cancelled;
  }

  list(): TaskNode[] {
    return [...this.tasks.values()].map(cloneTask);
  }

  private required(taskId: string): TaskNode {
    const task = this.tasks.get(taskId);
    if (!task) throw new AgentError('TASK_NOT_FOUND', `Task not found: ${taskId}`);
    return task;
  }

  private assertFence(task: TaskNode, fencingToken: number): void {
    if (!task.lease || task.lease.fencingToken !== fencingToken) {
      throw new AgentError('TASK_LEASE_STALE', `Stale task lease for ${task.taskId}`);
    }
    if (task.lease.expiresAt <= this.now()) {
      throw new AgentError('TASK_LEASE_EXPIRED', `Task lease expired for ${task.taskId}`);
    }
  }

  private budgetExceeded(task: TaskNode): boolean {
    return (
      (task.budget.maxTurns !== undefined && task.usage.turns >= task.budget.maxTurns) ||
      (task.budget.maxToolCalls !== undefined &&
        task.usage.toolCalls >= task.budget.maxToolCalls) ||
      (task.budget.maxTokens !== undefined && task.usage.tokens >= task.budget.maxTokens) ||
      (task.budget.deadlineMs !== undefined &&
        task.usage.startedAt !== undefined &&
        this.now() - task.usage.startedAt >= task.budget.deadlineMs)
    );
  }
}

function cloneTask(task: TaskNode): TaskNode {
  return {
    ...task,
    budget: { ...task.budget },
    usage: { ...task.usage },
    ...(task.lease ? { lease: { ...task.lease } } : {}),
    ...(task.checkpoint !== undefined
      ? { checkpoint: structuredClone(task.checkpoint) }
      : {}),
    children: [...task.children],
  };
}
