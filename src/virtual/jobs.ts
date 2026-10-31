import { AgentError } from '../core/errors';
import type { VirtualKeyValueStore } from './persistent-fs';
import type {
  VirtualCommandResult,
  VirtualShell,
} from './shell';

export type VirtualJobStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export interface VirtualJob {
  id: string;
  script: string;
  cwd: string;
  status: VirtualJobStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  exitCode?: number;
  stdout: string;
  stderr: string;
  error?: string;
}

interface QueuedJob {
  id: string;
  script: string;
  stdin: string;
}

interface PersistedJobs {
  schemaVersion: 1;
  jobs: VirtualJob[];
}

export interface VirtualJobManagerOptions {
  storage?: VirtualKeyValueStore;
  storageKey?: string;
  ids?: () => string;
  now?: () => number;
  maxConcurrent?: number;
  maxJobs?: number;
  maxOutputChars?: number;
}

export class VirtualJobManager {
  private readonly jobs = new Map<string, VirtualJob>();
  private readonly queue: QueuedJob[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private readonly storage?: VirtualKeyValueStore;
  private readonly storageKey: string;
  private readonly nextId: () => string;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly maxJobs: number;
  private readonly maxOutputChars: number;
  private loading?: Promise<void>;
  private running = 0;
  private sequence = 0;

  constructor(
    private readonly shell: VirtualShell,
    options: VirtualJobManagerOptions = {}
  ) {
    this.storage = options.storage;
    this.storageKey = options.storageKey ?? 'tinyai:virtual-jobs:v1';
    this.nextId =
      options.ids ?? (() => `job_${++this.sequence}`);
    this.now = options.now ?? (() => Date.now());
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 2);
    this.maxJobs = Math.max(1, options.maxJobs ?? 100);
    this.maxOutputChars = Math.max(1_000, options.maxOutputChars ?? 1_000_000);
  }

  async start(
    script: string,
    options: { stdin?: string } = {}
  ): Promise<VirtualJob> {
    await this.ensureLoaded();
    const normalized = script.trim();
    if (!normalized) {
      throw new AgentError('JOB_SCRIPT_EMPTY', 'Virtual job script cannot be empty');
    }
    this.prune();
    const id = this.nextId();
    const job: VirtualJob = {
      id,
      script: normalized,
      cwd: this.shell.currentDirectory,
      status: 'queued',
      createdAt: this.now(),
      stdout: '',
      stderr: '',
    };
    this.jobs.set(id, job);
    this.queue.push({ id, script: normalized, stdin: options.stdin ?? '' });
    await this.persist();
    this.drain();
    return cloneJob(job);
  }

  async list(): Promise<VirtualJob[]> {
    await this.ensureLoaded();
    return [...this.jobs.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cloneJob);
  }

  async get(id: string): Promise<VirtualJob | undefined> {
    await this.ensureLoaded();
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : undefined;
  }

  async read(id: string): Promise<VirtualJob> {
    const job = await this.get(id);
    if (!job) throw notFound(id);
    return job;
  }

  async wait(id: string): Promise<VirtualJob> {
    await this.ensureLoaded();
    const current = this.jobs.get(id);
    if (!current) throw notFound(id);
    if (isTerminal(current.status)) return cloneJob(current);
    await new Promise<void>((resolve) => {
      const waiters = this.waiters.get(id) ?? new Set<() => void>();
      waiters.add(resolve);
      this.waiters.set(id, waiters);
    });
    return cloneJob(this.jobs.get(id)!);
  }

  async cancel(id: string): Promise<VirtualJob> {
    await this.ensureLoaded();
    const job = this.jobs.get(id);
    if (!job) throw notFound(id);
    if (isTerminal(job.status)) return cloneJob(job);
    if (job.status === 'queued') {
      const index = this.queue.findIndex((item) => item.id === id);
      if (index >= 0) this.queue.splice(index, 1);
      finish(job, 'cancelled', this.now(), {
        exitCode: 130,
        error: 'Cancelled before execution',
      });
      this.wake(id);
      await this.persist();
      return cloneJob(job);
    }
    this.controllers.get(id)?.abort();
    return cloneJob(job);
  }

  async dispose(): Promise<void> {
    const active = [...this.jobs.values()].filter(
      (job) => job.status === 'queued' || job.status === 'running'
    );
    await Promise.all(active.map((job) => this.cancel(job.id)));
  }

  private drain(): void {
    while (this.running < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift()!;
      const job = this.jobs.get(next.id);
      if (!job || job.status !== 'queued') continue;
      this.running += 1;
      void this.run(next).finally(() => {
        this.running -= 1;
        this.drain();
      });
    }
  }

  private async run(item: QueuedJob): Promise<void> {
    const job = this.jobs.get(item.id);
    if (!job) return;
    const controller = new AbortController();
    this.controllers.set(item.id, controller);
    job.status = 'running';
    job.startedAt = this.now();
    await this.persist();
    try {
      const result = await this.shell.execute(item.script, {
        stdin: item.stdin,
        signal: controller.signal,
      });
      applyResult(job, result, this.now(), this.maxOutputChars);
    } catch (error) {
      const cancelled = controller.signal.aborted;
      finish(job, cancelled ? 'cancelled' : 'failed', this.now(), {
        exitCode: cancelled ? 130 : 1,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.controllers.delete(item.id);
      this.wake(item.id);
      await this.persist();
    }
  }

  private wake(id: string): void {
    const waiters = this.waiters.get(id);
    if (!waiters) return;
    for (const resolve of waiters) resolve();
    this.waiters.delete(id);
  }

  private prune(): void {
    if (this.jobs.size < this.maxJobs) return;
    const removable = [...this.jobs.values()]
      .filter((job) => isTerminal(job.status))
      .sort((left, right) => left.createdAt - right.createdAt);
    while (this.jobs.size >= this.maxJobs && removable.length) {
      this.jobs.delete(removable.shift()!.id);
    }
    if (this.jobs.size >= this.maxJobs) {
      throw new AgentError(
        'JOB_LIMIT_REACHED',
        `Virtual job limit reached: ${this.maxJobs}`
      );
    }
  }

  private async ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    await this.loading;
  }

  private async load(): Promise<void> {
    const raw = await this.storage?.get(this.storageKey);
    if (!raw) return;
    if (!isPersistedJobs(raw)) {
      throw new AgentError(
        'JOB_STORAGE_INVALID',
        'Persisted virtual job state is invalid'
      );
    }
    for (const persisted of raw.jobs) {
      const job = cloneJob(persisted);
      if (job.status === 'queued' || job.status === 'running') {
        finish(job, 'interrupted', this.now(), {
          exitCode: 1,
          error: 'Runtime restarted before the job completed',
        });
      }
      this.jobs.set(job.id, job);
    }
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    const state: PersistedJobs = {
      schemaVersion: 1,
      jobs: [...this.jobs.values()].map(cloneJob),
    };
    await this.storage.set(this.storageKey, state);
  }
}

function applyResult(
  job: VirtualJob,
  result: VirtualCommandResult,
  completedAt: number,
  maxOutputChars: number
): void {
  job.stdout = truncate(result.stdout, maxOutputChars);
  job.stderr = truncate(result.stderr, maxOutputChars);
  job.exitCode = result.exitCode;
  job.completedAt = completedAt;
  job.status = result.exitCode === 0 ? 'completed' : 'failed';
  if (result.exitCode !== 0) {
    job.error = `Virtual command exited with code ${result.exitCode}`;
  }
}

function finish(
  job: VirtualJob,
  status: VirtualJobStatus,
  completedAt: number,
  details: { exitCode: number; error: string }
): void {
  job.status = status;
  job.completedAt = completedAt;
  job.exitCode = details.exitCode;
  job.error = details.error;
}

function isTerminal(status: VirtualJobStatus): boolean {
  return status !== 'queued' && status !== 'running';
}

function cloneJob(job: VirtualJob): VirtualJob {
  return { ...job };
}

function truncate(value: string, max: number): string {
  return value.length > max
    ? `${value.slice(0, max)}\n…(truncated ${value.length - max} chars)`
    : value;
}

function notFound(id: string): AgentError {
  return new AgentError('JOB_NOT_FOUND', `Virtual job not found: ${id}`);
}

function isPersistedJobs(value: unknown): value is PersistedJobs {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      (value as PersistedJobs).schemaVersion === 1 &&
      Array.isArray((value as PersistedJobs).jobs)
  );
}
