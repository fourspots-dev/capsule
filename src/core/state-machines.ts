import { AgentError } from './errors';
import type { InputLedgerStatus, SessionLifecycleState, TaskStatus } from './types';

const lifecycleTransitions: Record<SessionLifecycleState, readonly SessionLifecycleState[]> = {
  unloaded: ['starting'],
  starting: ['ready', 'faulted'],
  ready: ['stopping', 'faulted'],
  stopping: ['unloaded', 'faulted'],
  faulted: [],
};

const taskTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['waiting', 'paused', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'paused', 'completed', 'failed', 'cancelled'],
  paused: ['queued', 'running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionLifecycle(
  from: SessionLifecycleState,
  to: SessionLifecycleState
): boolean {
  return lifecycleTransitions[from].includes(to);
}

export function assertLifecycleTransition(
  from: SessionLifecycleState,
  to: SessionLifecycleState
): void {
  if (!canTransitionLifecycle(from, to)) {
    throw new AgentError(
      'LIFECYCLE_TRANSITION_INVALID',
      `Invalid session lifecycle transition: ${from} -> ${to}`
    );
  }
}

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return taskTransitions[from].includes(to);
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransitionTask(from, to)) {
    throw new AgentError('TASK_TRANSITION_INVALID', `Invalid task transition: ${from} -> ${to}`);
  }
}

export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

export function isTerminalInputStatus(status: InputLedgerStatus): boolean {
  return status === 'promoted' || status === 'cancelled' || status === 'discarded' || status === 'failed';
}
