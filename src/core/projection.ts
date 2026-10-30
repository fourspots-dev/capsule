import type {
  ActionAvailability,
  ConversationPhase,
  ProductProjection,
  SessionView,
} from './types';

function phaseFor(view: SessionView): ConversationPhase {
  if (view.lifecycle === 'faulted') return 'error';
  if (view.lifecycle === 'starting') return 'prewarming';
  if (!view.activeTaskId && view.rows.length === 0) return 'draft';
  if (view.taskStatus === 'running' || view.taskStatus === 'queued') return 'running';
  if (view.taskStatus === 'waiting' || view.pendingApproval) return 'waiting';
  if (view.taskStatus === 'failed') return 'error';
  if (view.taskStatus === 'completed' || view.taskStatus === 'cancelled') return 'completed';
  return 'draft';
}

function availabilityFor(view: SessionView): ActionAvailability {
  const ready = view.lifecycle === 'ready';
  const active = view.taskStatus === 'queued' || view.taskStatus === 'running' || view.taskStatus === 'waiting';
  return {
    canSend: ready,
    canStop: ready && active,
    canApprove: ready && view.pendingApproval,
    canQueue: ready && view.taskStatus === 'running',
  };
}

export function buildProjection(view: SessionView): ProductProjection {
  const availability = availabilityFor(view);
  const active = view.taskStatus === 'queued' || view.taskStatus === 'running' || view.taskStatus === 'waiting';
  return {
    sessionId: view.sessionId,
    revision: view.revision,
    eventSeq: view.eventSeq,
    logEpoch: view.logEpoch,
    phase: phaseFor(view),
    lifecycle: view.lifecycle,
    taskStatus: view.taskStatus,
    inputRouting: !availability.canSend
      ? 'blocked'
      : active
        ? 'queue'
        : 'startNow',
    queueLength: view.queueLength,
    ...(view.activeTaskId ? { activeTaskId: view.activeTaskId } : {}),
    ...(view.lastError ? { lastError: view.lastError } : {}),
    permissionMode: view.permissionMode,
    ...(view.plan ? { plan: { ...view.plan } } : {}),
    ...(view.children?.length
      ? { children: view.children.map((child) => ({ ...child })) }
      : {}),
    rows: view.rows.map((row) => ({ ...row })),
    availability,
  };
}

export type ProjectionDelta =
  | { type: 'row.appended'; row: ProductProjection['rows'][number] }
  | { type: 'row.upserted'; row: ProductProjection['rows'][number] }
  | { type: 'row.removed'; fromRowId: string }
  | { type: 'row.delta'; rowId: string; path: 'text'; append: string }
  | { type: 'state.updated'; patch: Partial<Omit<ProductProjection, 'rows'>> };

export type ProjectionFrame =
  | {
      type: 'snapshot';
      projection: ProductProjection;
    }
  | {
      type: 'delta';
      sessionId: string;
      logEpoch: string;
      baseRevision: number;
      revision: number;
      eventSeq: number;
      deltas: ProjectionDelta[];
    };

export function applyProjectionDelta(
  current: ProductProjection,
  delta: ProjectionDelta
): ProductProjection {
  const next: ProductProjection = {
    ...current,
    rows: current.rows.map((row) => ({ ...row })),
  };
  if (delta.type === 'row.appended') next.rows.push({ ...delta.row });
  if (delta.type === 'row.upserted') {
    const index = next.rows.findIndex((row) => row.id === delta.row.id);
    if (index >= 0) next.rows[index] = { ...delta.row };
    else next.rows.push({ ...delta.row });
  }
  if (delta.type === 'row.removed') {
    next.rows = next.rows.filter((row) => row.id !== delta.fromRowId);
  }
  if (delta.type === 'row.delta') {
    const row = next.rows.find((candidate) => candidate.id === delta.rowId);
    if (!row) throw new Error(`Cannot apply row delta: ${delta.rowId}`);
    if (delta.path === 'text') row.text += delta.append;
  }
  if (delta.type === 'state.updated') Object.assign(next, delta.patch);
  return next;
}

export function createProjectionFrame(
  previous: ProductProjection | undefined,
  next: ProductProjection
): ProjectionFrame {
  if (
    !previous ||
    previous.sessionId !== next.sessionId ||
    previous.logEpoch !== next.logEpoch ||
    next.revision <= previous.revision
  ) {
    return { type: 'snapshot', projection: cloneProjection(next) };
  }

  const deltas: ProjectionDelta[] = [];
  const statePatch: Partial<Omit<ProductProjection, 'rows'>> = {};
  for (const key of [
    'phase',
    'lifecycle',
    'taskStatus',
    'inputRouting',
    'queueLength',
    'activeTaskId',
    'lastError',
    'permissionMode',
    'plan',
    'children',
    'availability',
  ] as const) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      (statePatch as Record<string, unknown>)[key] = next[key];
    }
  }
  if (Object.keys(statePatch).length) {
    deltas.push({ type: 'state.updated', patch: statePatch });
  }

  const previousRows = new Map(previous.rows.map((row) => [row.id, row]));
  const nextRows = new Map(next.rows.map((row) => [row.id, row]));
  for (const row of previous.rows) {
    if (!nextRows.has(row.id)) deltas.push({ type: 'row.removed', fromRowId: row.id });
  }
  for (const row of next.rows) {
    const old = previousRows.get(row.id);
    if (!old) {
      deltas.push({ type: 'row.appended', row: { ...row } });
      continue;
    }
    if (
      old.kind === row.kind &&
      old.entityId === row.entityId &&
      old.productTurnId === row.productTurnId &&
      old.status === row.status &&
      old.callId === row.callId &&
      old.toolName === row.toolName &&
      row.text.startsWith(old.text)
    ) {
      if (row.text !== old.text) {
        deltas.push({
          type: 'row.delta',
          rowId: row.id,
          path: 'text',
          append: row.text.slice(old.text.length),
        });
      }
    } else if (JSON.stringify(old) !== JSON.stringify(row)) {
      deltas.push({ type: 'row.upserted', row: { ...row } });
    }
  }
  return {
    type: 'delta',
    sessionId: next.sessionId,
    logEpoch: next.logEpoch,
    baseRevision: previous.revision,
    revision: next.revision,
    eventSeq: next.eventSeq,
    deltas,
  };
}

export function applyProjectionFrame(
  current: ProductProjection | undefined,
  frame: ProjectionFrame
): ProductProjection {
  if (frame.type === 'snapshot') return cloneProjection(frame.projection);
  if (!current) {
    throw new Error('Cannot apply a projection delta without a snapshot');
  }
  if (
    current.sessionId !== frame.sessionId ||
    current.logEpoch !== frame.logEpoch ||
    current.revision !== frame.baseRevision
  ) {
    throw new Error(
      `Projection frame gap: expected ${current.revision}, received ${frame.baseRevision}`
    );
  }
  let next = cloneProjection(current);
  for (const delta of frame.deltas) next = applyProjectionDelta(next, delta);
  next.revision = frame.revision;
  next.eventSeq = frame.eventSeq;
  return next;
}

export class ProjectionStore {
  private current?: ProductProjection;
  private previous?: ProductProjection;

  apply(frame: ProjectionFrame): ProductProjection {
    this.previous = this.current;
    this.current = applyProjectionFrame(this.current, frame);
    return cloneProjection(this.current);
  }

  snapshot(): ProductProjection | undefined {
    return this.current ? cloneProjection(this.current) : undefined;
  }

  frame(next: ProductProjection): ProjectionFrame {
    return createProjectionFrame(this.previous ?? this.current, next);
  }
}

function cloneProjection(projection: ProductProjection): ProductProjection {
  return {
    ...projection,
    ...(projection.lastError
      ? { lastError: { ...projection.lastError } }
      : {}),
    availability: { ...projection.availability },
    ...(projection.children
      ? { children: projection.children.map((child) => ({ ...child })) }
      : {}),
    rows: projection.rows.map((row) => ({ ...row })),
  };
}
