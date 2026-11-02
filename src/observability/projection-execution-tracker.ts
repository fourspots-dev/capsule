import type {
  ChildTaskProjection,
  ConversationRow,
  ProductProjection,
} from '../core/types';
import type {
  ExecutionEventInput,
  ExecutionEventKind,
  ExecutionEventPhase,
} from './execution-event';
import type { SessionProjectionChange } from '../core/session-runtime';

export class ProjectionExecutionTracker {
  private readonly sessions = new Map<
    string,
    {
      revision: number;
      taskStatus: string;
      rows: Map<string, ConversationRow>;
      children: Map<string, ChildTaskProjection>;
    }
  >();
  private readonly rowKinds = new Map<string, ExecutionEventKind>();
  private readonly rowLengths = new Map<string, number>();

  observeChange(change: SessionProjectionChange): ExecutionEventInput[] {
    const events: ExecutionEventInput[] = [];
    for (const delta of change.deltas) {
      if (delta.type === 'state.updated') {
        if (delta.patch.taskStatus || delta.patch.phase || delta.patch.lastError) {
          const taskStatus = delta.patch.taskStatus ?? 'updated';
          events.push({
            clientEventId: `${change.sessionId}:${change.revision}:state`,
            timestamp: Date.now(),
            sessionId: change.sessionId,
            ...(delta.patch.activeTaskId
              ? { taskId: delta.patch.activeTaskId }
              : {}),
            kind: taskStatus === 'failed' ? 'error' : 'status',
            phase:
              taskStatus === 'failed'
                ? 'failed'
                : taskStatus === 'cancelled'
                  ? 'cancelled'
                  : taskStatus === 'completed'
                    ? 'completed'
                    : 'updated',
            actor: 'system',
            payload: {
              ...(delta.patch.taskStatus
                ? { taskStatus: delta.patch.taskStatus }
                : {}),
              ...(delta.patch.phase ? { phase: delta.patch.phase } : {}),
              ...(delta.patch.queueLength !== undefined
                ? { queueLength: delta.patch.queueLength }
                : {}),
            },
          });
        }
        for (const child of delta.patch.children ?? []) {
          events.push({
            clientEventId: `${change.sessionId}:${change.revision}:child:${child.taskId}:${child.status}`,
            timestamp: child.updatedAt ?? Date.now(),
            sessionId: change.sessionId,
            taskId: child.taskId,
            parentId: child.parentTaskId,
            kind: 'child-agent',
            phase: childPhase(child.status),
            actor: 'child-agent',
            payload: { ...child },
          });
        }
        continue;
      }
      if (delta.type === 'row.removed') {
        const kind = this.rowKinds.get(delta.fromRowId) ?? 'status';
        this.rowKinds.delete(delta.fromRowId);
        this.rowLengths.delete(delta.fromRowId);
        events.push({
          clientEventId: `${change.sessionId}:${change.revision}:removed:${delta.fromRowId}`,
          timestamp: Date.now(),
          sessionId: change.sessionId,
          kind,
          phase: 'cancelled',
          actor: 'system',
          payload: { rowId: delta.fromRowId, removed: true },
        });
        continue;
      }
      if (delta.type === 'row.delta') {
        const kind = this.rowKinds.get(delta.rowId) ?? 'assistant';
        const textLength =
          (this.rowLengths.get(delta.rowId) ?? 0) + delta.append.length;
        this.rowLengths.set(delta.rowId, textLength);
        events.push({
          clientEventId: `${change.sessionId}:${change.revision}:row:${delta.rowId}:delta`,
          timestamp: Date.now(),
          sessionId: change.sessionId,
          kind,
          phase: 'updated',
          actor:
            kind === 'reasoning' || kind === 'assistant' ? 'agent' : 'tool',
          ...(kind === 'reasoning'
            ? { visibility: 'displayed-reasoning' as const }
            : {}),
          payload: {
            rowId: delta.rowId,
            delta: delta.append,
            textLength,
            status: 'streaming',
          },
        });
        continue;
      }
      const row = delta.row;
      const kind = rowKind(row);
      this.rowKinds.set(row.id, kind);
      this.rowLengths.set(row.id, row.text.length);
      events.push({
        clientEventId: `${change.sessionId}:${change.revision}:row:${row.id}:${row.status}`,
        timestamp: row.completedAt ?? row.startedAt ?? Date.now(),
        sessionId: change.sessionId,
        taskId: row.productTurnId,
        productTurnId: row.productTurnId,
        ...(row.callId ? { callId: row.callId } : {}),
        kind,
        phase: rowPhase(row, delta.type === 'row.upserted' ? row : undefined),
        actor:
          kind === 'user'
            ? 'user'
            : kind === 'tool'
              ? 'tool'
              : kind === 'reasoning' || kind === 'assistant'
                ? 'agent'
                : 'system',
        ...(kind === 'reasoning'
          ? { visibility: 'displayed-reasoning' as const }
          : {}),
        payload: toRowPayload(row, undefined),
      });
    }
    return events;
  }

  observe(projection: ProductProjection): ExecutionEventInput[] {
    const id = (suffix: string) =>
      `${projection.sessionId}:${projection.revision}:${suffix}`;
    const previous = this.sessions.get(projection.sessionId);
    const events: ExecutionEventInput[] = [];
    const previousRows = previous?.rows ?? new Map<string, ConversationRow>();
    const nextRows = new Map(projection.rows.map((row) => [row.id, row]));

    if (
      !previous ||
      previous.taskStatus !== projection.taskStatus ||
      previous.revision === 0
    ) {
      events.push({
        clientEventId: id(`status:${projection.taskStatus}`),
        timestamp: Date.now(),
        sessionId: projection.sessionId,
        ...(projection.activeTaskId ? { taskId: projection.activeTaskId } : {}),
        kind: projection.taskStatus === 'failed' ? 'error' : 'status',
        phase:
          projection.taskStatus === 'failed'
            ? 'failed'
            : projection.taskStatus === 'cancelled'
              ? 'cancelled'
              : ['completed'].includes(projection.taskStatus)
                ? 'completed'
                : 'updated',
        actor: 'system',
        payload: {
          taskStatus: projection.taskStatus,
          phase: projection.phase,
        },
      });
    }

    for (const row of projection.rows) {
      this.rowKinds.set(row.id, rowKind(row));
      this.rowLengths.set(row.id, row.text.length);
      const old = previousRows.get(row.id);
      if (old && sameRowState(old, row)) continue;
      const kind = rowKind(row);
      const phase = rowPhase(row, old);
      const delta =
        old && row.text.startsWith(old.text)
          ? row.text.slice(old.text.length)
          : undefined;
      events.push({
        clientEventId: id(`row:${row.id}:${row.status}`),
        timestamp: row.completedAt ?? row.startedAt ?? Date.now(),
        sessionId: projection.sessionId,
        taskId: row.productTurnId,
        productTurnId: row.productTurnId,
        ...(row.callId ? { callId: row.callId } : {}),
        kind,
        phase,
        actor:
          kind === 'user'
            ? 'user'
            : kind === 'tool'
              ? 'tool'
              : kind === 'reasoning' || kind === 'assistant'
                ? 'agent'
                : 'system',
        ...(kind === 'reasoning'
          ? { visibility: 'displayed-reasoning' as const }
          : {}),
        payload: toRowPayload(row, delta),
      });
    }

    for (const [rowId, row] of previousRows) {
      if (nextRows.has(rowId)) continue;
      events.push({
        clientEventId: id(`removed:${rowId}`),
        timestamp: Date.now(),
        sessionId: projection.sessionId,
        taskId: row.productTurnId,
        kind: rowKind(row),
        phase: 'cancelled',
        actor: 'system',
        payload: { rowId, removed: true, status: row.status },
      });
    }

    const previousChildren = previous?.children ?? new Map();
    for (const child of projection.children ?? []) {
      const old = previousChildren.get(child.taskId);
      if (
        old &&
        old.status === child.status &&
        old.summary === child.summary
      ) {
        continue;
      }
      events.push({
        clientEventId: id(`child:${child.taskId}:${child.status}`),
        timestamp: child.updatedAt ?? Date.now(),
        sessionId: projection.sessionId,
        taskId: child.taskId,
        parentId: child.parentTaskId,
        kind: 'child-agent',
        phase: childPhase(child.status),
        actor: 'child-agent',
        payload: { ...child },
      });
    }

    this.sessions.set(projection.sessionId, {
      revision: projection.revision,
      taskStatus: projection.taskStatus,
      rows: nextRows,
      children: new Map(
        (projection.children ?? []).map((child) => [child.taskId, { ...child }])
      ),
    });
    return events;
  }
}

function sameRowState(left: ConversationRow, right: ConversationRow): boolean {
  return (
    left.status === right.status &&
    left.text === right.text &&
    JSON.stringify(left.toolMetadata) === JSON.stringify(right.toolMetadata)
  );
}

function rowKind(row: ConversationRow): ExecutionEventKind {
  if (row.kind === 'user') return 'user';
  if (row.kind === 'assistant') return 'assistant';
  if (row.kind === 'reasoning') return 'reasoning';
  if (row.kind === 'tool') return 'tool';
  return row.status === 'failed' ? 'error' : 'status';
}

function rowPhase(
  row: ConversationRow,
  previous: ConversationRow | undefined
): ExecutionEventPhase {
  if (row.status === 'failed' || row.status === 'denied') return 'failed';
  if (row.status === 'cancelled') return 'cancelled';
  if (row.status === 'completed') return 'completed';
  return previous ? 'updated' : 'started';
}

function childPhase(status: ChildTaskProjection['status']): ExecutionEventPhase {
  if (status === 'failed') return 'failed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'completed') return 'completed';
  if (status === 'running') return 'updated';
  return 'started';
}

function toRowPayload(
  row: ConversationRow,
  delta: string | undefined
): ExecutionEventInput['payload'] {
  return {
    rowId: row.id,
    entityId: row.entityId,
    text: row.text,
    status: row.status,
    ...(delta ? { delta } : {}),
    ...(row.callId ? { callId: row.callId } : {}),
    ...(row.toolName ? { toolName: row.toolName } : {}),
    ...(row.toolMetadata
      ? { toolMetadata: structuredClone(row.toolMetadata) as never }
      : {}),
  } as unknown as ExecutionEventInput['payload'];
}
