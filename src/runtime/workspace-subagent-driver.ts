import type { ChildTaskSpec, ResolvedAgentProfile } from '../core/agent-profile';
import type { CommandAck, CommandEnvelope, ProductProjection } from '../core/types';
import type { ChildDriver, ChildResult } from '../core/subagent-coordinator';
import type { ChildMergePreview } from '../core/subagent-coordinator';
import type { WorkspaceRuntime } from '../core/workspace-runtime';
import type { VirtualWorkspace } from '../virtual';

interface ChildRuntime {
  taskId: string;
  sessionId: string;
  spec: ChildTaskSpec;
  profile: ResolvedAgentProfile;
  runtime: WorkspaceRuntime;
  workspace?: VirtualWorkspace;
}

export interface WorkspaceSubagentDriverOptions {
  createRuntime(request: {
    taskId: string;
    sessionId: string;
    spec: ChildTaskSpec;
    profile: ResolvedAgentProfile;
    workspace?: VirtualWorkspace;
  }): Promise<WorkspaceRuntime> | WorkspaceRuntime;
  forkWorkspace?(request: {
    taskId: string;
    parentTaskId: string;
    parentSessionId?: string;
    spec: ChildTaskSpec;
    profile: ResolvedAgentProfile;
  }): Promise<VirtualWorkspace | undefined> | VirtualWorkspace | undefined;
  disposeRuntime?: boolean;
  ids: { next(prefix: string): string };
  now?: () => number;
}

export class WorkspaceSubagentDriver implements ChildDriver {
  private readonly children = new Map<string, ChildRuntime>();

  constructor(private readonly options: WorkspaceSubagentDriverOptions) {}

  async create(request: {
    taskId: string;
    spec: ChildTaskSpec;
    profile: ResolvedAgentProfile;
    prompt: string;
  }): Promise<{ sessionId: string }> {
    const sessionId = this.options.ids.next('child_session');
    const workspace = await this.options.forkWorkspace?.({
      taskId: request.taskId,
      parentTaskId: request.spec.parentTaskId,
      ...(request.spec.parentSessionId
        ? { parentSessionId: request.spec.parentSessionId }
        : {}),
      spec: request.spec,
      profile: request.profile,
    });
    const runtime = await this.options.createRuntime({
      taskId: request.taskId,
      sessionId,
      spec: request.spec,
      profile: request.profile,
      ...(workspace ? { workspace } : {}),
    });
    this.children.set(request.taskId, {
      taskId: request.taskId,
      sessionId,
      spec: request.spec,
      profile: request.profile,
      runtime,
      ...(workspace ? { workspace } : {}),
    });
    this.prompts.set(request.taskId, request.prompt);
    return { sessionId };
  }

  async run(taskId: string, signal: AbortSignal): Promise<ChildResult> {
    const child = this.child(taskId);
    const prompt = this.prompts.get(taskId);
    if (!prompt) throw new Error(`Child prompt missing: ${taskId}`);
    if (signal.aborted) return cancelled();
    const ack = await child.runtime.command(
      this.command(child, `child_command_${this.options.ids.next('sequence')}`, prompt)
    );
    if (ack.status !== 'accepted' && ack.status !== 'duplicate') {
      return failed(ack);
    }
    const abort = () => {
      void child.runtime.command(this.stopCommand(child));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await child.runtime.waitForSessionIdle(child.sessionId);
    } finally {
      signal.removeEventListener('abort', abort);
    }
    return resultFromProjection(child.runtime.getProjection(child.sessionId), signal.aborted);
  }

  async send(taskId: string, message: string, delivery: 'guide' | 'queue'): Promise<void> {
    const child = this.child(taskId);
    const ack = await child.runtime.command({
      ...this.command(child, `child_message_${this.options.ids.next('sequence')}`, message),
      payload: { text: message, delivery },
    });
    if (ack.status !== 'accepted' && ack.status !== 'duplicate') throw ackError(ack);
  }

  async stop(taskId: string): Promise<void> {
    const child = this.child(taskId);
    await child.runtime.command(this.stopCommand(child));
  }

  projection(taskId: string): ProductProjection | undefined {
    const child = this.children.get(taskId);
    if (!child) return undefined;
    try {
      return child.runtime.getProjection(child.sessionId);
    } catch {
      return undefined;
    }
  }

  async previewMerge(taskId: string): Promise<ChildMergePreview> {
    const child = this.child(taskId);
    if (!child.workspace?.parent) {
      throw new Error(`Child workspace fork not found: ${taskId}`);
    }
    const preview = await child.workspace.parent.previewMerge(child.workspace);
    return {
      taskId,
      workspaceId: child.workspace.workspaceId,
      changes: preview.changes,
      conflicts: preview.conflicts,
    };
  }

  async applyMerge(taskId: string): Promise<ChildMergePreview> {
    const child = this.child(taskId);
    if (!child.workspace?.parent) {
      throw new Error(`Child workspace fork not found: ${taskId}`);
    }
    const preview = await child.workspace.parent.applyMerge(child.workspace);
    return {
      taskId,
      workspaceId: child.workspace.workspaceId,
      changes: preview.changes,
      conflicts: preview.conflicts,
    };
  }

  async discardWorkspace(taskId: string): Promise<void> {
    const child = this.child(taskId);
    if (child.workspace?.parent) {
      await child.workspace.parent.discardFork(child.workspace);
    }
  }

  async resume(taskId: string, message: string): Promise<ChildResult> {
    const child = this.child(taskId);
    const ack = await child.runtime.command(
      this.command(child, `child_resume_${this.options.ids.next('sequence')}`, message)
    );
    if (ack.status !== 'accepted' && ack.status !== 'duplicate') return failed(ack);
    await child.runtime.waitForSessionIdle(child.sessionId);
    return resultFromProjection(child.runtime.getProjection(child.sessionId), false);
  }

  async dispose(): Promise<void> {
    if (this.options.disposeRuntime !== false) {
      await Promise.all([...this.children.values()].map((child) => child.runtime.dispose()));
    }
    this.children.clear();
    this.prompts.clear();
  }

  setPrompt(taskId: string, prompt: string): void {
    this.prompts.set(taskId, prompt);
  }

  private readonly prompts = new Map<string, string>();

  private child(taskId: string): ChildRuntime {
    const child = this.children.get(taskId);
    if (!child) throw new Error(`Child runtime not found: ${taskId}`);
    return child;
  }

  private command(
    child: ChildRuntime,
    commandId: string,
    text: string
  ): CommandEnvelope {
    return {
      commandId,
      clientId: 'subagent-coordinator',
      sessionId: child.sessionId,
      type: 'send_input',
      payload: { text },
      issuedAt: this.options.now?.() ?? Date.now(),
    };
  }

  private stopCommand(child: ChildRuntime): CommandEnvelope {
    return {
      commandId: `child_stop_${this.options.ids.next('sequence')}`,
      clientId: 'subagent-coordinator',
      sessionId: child.sessionId,
      type: 'stop',
      payload: { reason: 'parent_cancelled' },
      issuedAt: this.options.now?.() ?? Date.now(),
    };
  }
}

function resultFromProjection(
  projection: ProductProjection,
  aborted: boolean
): ChildResult {
  const assistant = [...projection.rows].reverse().find((row) => row.kind === 'assistant');
  const evidence = projection.rows.flatMap((row) =>
    row.kind === 'tool' && row.toolMetadata?.evidence
      ? [structuredClone(row.toolMetadata.evidence)]
      : []
  );
  const artifactIds = [
    ...new Set(
      projection.rows.flatMap(
        (row) => row.toolMetadata?.artifactIds ?? []
      )
    ),
  ];
  const status = aborted
    ? 'cancelled'
    : projection.taskStatus === 'completed'
      ? 'completed'
      : projection.taskStatus === 'cancelled'
        ? 'cancelled'
        : 'failed';
  return {
    status,
    summary: assistant?.text || projection.lastError?.message || projection.taskStatus,
    output: {
      sessionId: projection.sessionId,
      rows: projection.rows,
      evidence,
    },
    artifacts: artifactIds,
    unresolved: status === 'completed' ? [] : [projection.lastError?.message ?? status],
    ...(projection.lastError ? { error: projection.lastError } : {}),
  };
}

function failed(ack: CommandAck): ChildResult {
  return {
    status: 'failed',
    summary: ack.error?.message ?? `Child command ${ack.status}`,
    artifacts: [],
    unresolved: [ack.error?.message ?? ack.status],
    ...(ack.error ? { error: ack.error } : {}),
  };
}

function cancelled(): ChildResult {
  return {
    status: 'cancelled',
    summary: 'Cancelled',
    artifacts: [],
    unresolved: [],
  };
}

function ackError(ack: CommandAck): Error {
  return Object.assign(new Error(ack.error?.message ?? `Child command ${ack.status}`), {
    name: ack.error?.code ?? 'CHILD_COMMAND_REJECTED',
  });
}
