import type { WorkspaceRuntime } from '../core/workspace-runtime';
import type {
  CommandAck,
  CommandEnvelope,
  ProductProjection,
} from '../core/types';
import type {
  ProjectionEnvelope,
  RuntimeSessionSummary,
  TuiRuntimePort,
} from './types';

export interface LocalTuiRuntimeOptions {
  project?: string;
  branch?: string;
}

/**
 * Adapts the in-process WorkspaceRuntime to the same semantics consumed by
 * remote TUI/Web clients. UI-specific workspace/project labels stay here.
 */
export class LocalTuiRuntimePort implements TuiRuntimePort {
  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly options: LocalTuiRuntimeOptions = {}
  ) {}

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    return (await this.runtime.listSessions()).map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      taskStatus: session.taskStatus,
      revision: session.revision,
      eventSeq: session.eventSeq,
      updatedAt: session.updatedAt,
      rowCount: session.rowCount,
      childCount: session.childCount,
      attentionCount: session.attentionCount,
      ...(this.options.project ? { project: this.options.project } : {}),
      ...(this.options.branch ? { branch: this.options.branch } : {}),
    }));
  }

  loadProjection(sessionId: string): Promise<ProductProjection> {
    return this.runtime.loadProjection(sessionId);
  }

  async subscribe(
    sessionId: string,
    subscriptionId: string,
    listener: (envelope: ProjectionEnvelope) => void
  ): Promise<() => void> {
    return this.runtime.subscribe(sessionId, (projection) => {
      listener({
        sessionId,
        logEpoch: projection.logEpoch,
        subscriptionId,
        frame: { type: 'snapshot', projection },
      });
    });
  }

  command(command: CommandEnvelope): Promise<CommandAck> {
    return this.runtime.command(command);
  }

  stopSession(sessionId: string): Promise<void> {
    return this.runtime.stop(sessionId);
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.runtime.deleteSession(sessionId);
  }

  renameSession(sessionId: string, title: string): Promise<void> {
    return this.runtime.renameSession(sessionId, title);
  }
}
