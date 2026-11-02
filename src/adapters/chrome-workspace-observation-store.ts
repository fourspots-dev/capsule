import type { HostStorage } from '../host';
import type { WorkspaceApplicationObservation } from '../platform/workspace-interaction';

const PREFIX = 'tinyai:workspace-observations:v1:';

export class ChromeWorkspaceObservationStore {
  constructor(private readonly storage: HostStorage) {}

  async save(observation: WorkspaceApplicationObservation): Promise<void> {
    const key = this.key(observation.sessionId, observation.taskId);
    const records = await this.list(observation);
    const next = [
      ...records.filter((record) => record.id !== observation.id),
      structuredClone(observation),
    ].slice(-20);
    await this.storage.set(key, next);
  }

  async list(input: {
    sessionId: string;
    taskId: string;
  }): Promise<WorkspaceApplicationObservation[]> {
    const value = await this.storage.get(
      this.key(input.sessionId, input.taskId)
    );
    return Array.isArray(value)
      ? (structuredClone(value) as WorkspaceApplicationObservation[])
      : [];
  }

  async clear(): Promise<void> {
    for (const key of (await this.storage.list?.(PREFIX)) ?? []) {
      await this.storage.remove?.(key);
    }
  }

  async clearSession(sessionId: string): Promise<void> {
    const prefix = `${PREFIX}${encodeURIComponent(sessionId)}:`;
    for (const key of (await this.storage.list?.(prefix)) ?? []) {
      await this.storage.remove?.(key);
    }
  }

  private key(sessionId: string, taskId: string): string {
    return `${PREFIX}${encodeURIComponent(sessionId)}:${encodeURIComponent(taskId)}`;
  }
}
