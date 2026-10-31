import type {
  ChildTaskProjection,
  ConversationRow,
  ProductProjection,
} from '../core/types';

export type WorkItemKind =
  | 'reasoning'
  | 'assistant'
  | 'tool'
  | 'tool-group'
  | 'plan'
  | 'activity'
  | 'child';

export interface WorkToolGroup {
  key: string;
  family: ToolFamily;
  rows: ConversationRow[];
}

export interface WorkItem {
  kind: WorkItemKind;
  key: string;
  row?: ConversationRow;
  group?: WorkToolGroup;
  child?: ChildTaskProjection;
}

export interface WorkSegment {
  key: string;
  user?: ConversationRow;
  historyRows: ConversationRow[];
  latestAssistant?: ConversationRow;
  tailRows: ConversationRow[];
  children: ChildTaskProjection[];
  workItems: WorkItem[];
  running: boolean;
  state: 'running' | 'completed' | 'failed' | 'cancelled' | 'idle';
  durationMs?: number;
  defaultOpen: boolean;
}

export interface TurnRenderUnit {
  key: string;
  productTurnId: string;
  segments: WorkSegment[];
  rows: ConversationRow[];
  children: ChildTaskProjection[];
}

export type ToolFamily =
  | 'explore'
  | 'browser'
  | 'terminal'
  | 'changes'
  | 'subagent'
  | 'artifact'
  | 'other';

const EXPLORE_TOOLS = new Set([
  'list_tabs',
  'list_frames',
  'snapshot',
  'read_page',
  'find',
  'wait',
  'scroll',
  'list_files',
  'read_file',
]);

const TERMINAL_TOOLS = new Set(['exec', 'run_tests']);
const CHANGE_TOOLS = new Set([
  'write_file',
  'apply_patch',
  'apply_unified_diff',
  'edit',
]);
const SUBAGENT_TOOLS = new Set([
  'spawn_agent',
  'send_message',
  'wait_agent',
  'stop_agent',
  'list_agents',
]);

export function buildTurnRenderUnits(projection: ProductProjection): TurnRenderUnit[] {
  const grouped = new Map<string, ConversationRow[]>();
  for (const row of projection.rows) {
    const turnId = row.productTurnId || 'unassigned';
    const rows = grouped.get(turnId) ?? [];
    rows.push(row);
    grouped.set(turnId, rows);
  }

  return [...grouped.entries()].map(([productTurnId, rows]) => {
    const children = (projection.children ?? []).filter(
      (child) => child.parentTaskId === productTurnId
    );
    return {
      key: productTurnId,
      productTurnId,
      rows,
      children,
      segments: splitSegments(
        productTurnId,
        rows,
        children,
        projection.taskStatus,
        projection
      ),
    };
  });
}

function splitSegments(
  productTurnId: string,
  rows: ConversationRow[],
  children: ChildTaskProjection[],
  taskStatus: ProductProjection['taskStatus'],
  projection: ProductProjection
): WorkSegment[] {
  const starts = rows
    .map((row, index) => (row.kind === 'user' ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length === 0) {
    return [
      buildSegment(
        productTurnId,
        `${productTurnId}:0`,
        undefined,
        rows,
        children,
        taskStatus,
        projection
      ),
    ];
  }

  return starts.map((start, index) => {
    const end = starts[index + 1] ?? rows.length;
    return buildSegment(
      productTurnId,
      `${productTurnId}:${index}`,
      rows[start],
      rows.slice(start + 1, end),
      index === starts.length - 1 ? children : [],
      taskStatus,
      projection
    );
  });
}

function buildSegment(
  productTurnId: string,
  key: string,
  user: ConversationRow | undefined,
  rows: ConversationRow[],
  children: ChildTaskProjection[],
  taskStatus: ProductProjection['taskStatus'],
  projection: ProductProjection
): WorkSegment {
  const latestAssistantIndex = findLatestAssistantIndex(rows);
  const historyRows =
    latestAssistantIndex >= 0 ? rows.slice(0, latestAssistantIndex) : rows;
  const latestAssistant =
    latestAssistantIndex >= 0 ? rows[latestAssistantIndex] : undefined;
  const tailRows =
    latestAssistantIndex >= 0 ? rows.slice(latestAssistantIndex + 1) : [];
  const activeProductTurn =
    !projection.activeTaskId || projection.activeTaskId === productTurnId;
  const running =
    activeProductTurn &&
    (projection.taskStatus === 'running' ||
      projection.taskStatus === 'queued' ||
      projection.taskStatus === 'waiting');
  const state =
    taskStatus === 'completed'
      ? 'completed'
      : taskStatus === 'failed'
        ? 'failed'
        : taskStatus === 'cancelled'
          ? 'cancelled'
          : running
            ? 'running'
            : 'idle';
  const durationMs = durationOf(rows);
  const defaultOpen =
    running ||
    state === 'failed' ||
    state === 'cancelled' ||
    !latestAssistant ||
    children.some((child) => child.status === 'running');

  return {
    key,
    user,
    historyRows,
    latestAssistant,
    tailRows,
    children,
    workItems: buildWorkItems(historyRows, children),
    running,
    state,
    durationMs,
    defaultOpen,
  };
}

function findLatestAssistantIndex(rows: ConversationRow[]): number {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row.kind !== 'assistant' || !row.text.trim()) continue;
    const followedByWork = rows
      .slice(index + 1)
      .some((candidate) => candidate.kind === 'tool' || candidate.kind === 'reasoning');
    return followedByWork ? -1 : index;
  }
  return -1;
}

function durationOf(rows: ConversationRow[]): number | undefined {
  const durations = rows.flatMap((row) =>
    row.kind === 'activity' &&
    typeof row.startedAt === 'number' &&
    typeof row.completedAt === 'number'
      ? [Math.max(0, row.completedAt - row.startedAt)]
      : []
  );
  return durations.length ? durations.reduce((total, duration) => total + duration, 0) : undefined;
}

function buildWorkItems(
  rows: ConversationRow[],
  children: ChildTaskProjection[]
): WorkItem[] {
  const items: WorkItem[] = [];
  let pendingGroup: WorkToolGroup | undefined;

  const flushGroup = (): void => {
    if (!pendingGroup) return;
    if (pendingGroup.rows.length >= 2) {
      items.push({
        kind: 'tool-group',
        key: pendingGroup.key,
        group: pendingGroup,
      });
    } else {
      const row = pendingGroup.rows[0];
      items.push({ kind: 'tool', key: row.id, row });
    }
    pendingGroup = undefined;
  };

  for (const row of rows) {
    if (row.kind === 'tool') {
      const family = toolFamily(row.toolName ?? '');
      if (family !== 'other') {
        if (pendingGroup?.family === family) {
          pendingGroup.rows.push(row);
        } else {
          flushGroup();
          pendingGroup = {
            key: `group:${row.id}`,
            family,
            rows: [row],
          };
        }
        continue;
      }
    }
    flushGroup();
    if (
      row.kind === 'activity' &&
      (row.text === 'Thinking' || row.text === 'Thinking complete')
    ) {
      continue;
    }
    if (row.kind === 'assistant' && row.status === 'streaming' && !row.text.trim()) continue;
    items.push({
      kind:
        row.kind === 'reasoning'
          ? 'reasoning'
          : row.kind === 'assistant'
            ? 'assistant'
            : row.kind === 'plan'
              ? 'plan'
              : row.kind === 'activity'
                ? 'activity'
                : 'tool',
      key: row.id,
      row,
    });
  }
  flushGroup();
  for (const child of children) {
    items.push({ kind: 'child', key: `child:${child.taskId}`, child });
  }
  return items;
}

export function toolFamily(name: string): ToolFamily {
  if (EXPLORE_TOOLS.has(name)) return 'explore';
  if (TERMINAL_TOOLS.has(name)) return 'terminal';
  if (CHANGE_TOOLS.has(name)) return 'changes';
  if (SUBAGENT_TOOLS.has(name)) return 'subagent';
  if (name === 'screenshot' || name.includes('artifact')) return 'artifact';
  if (
    ['navigate', 'click', 'mouse_click', 'fill', 'select_option', 'type_text', 'send_keys'].includes(
      name
    )
  ) {
    return 'browser';
  }
  return 'other';
}

export function workStateLabel(
  segment: WorkSegment,
  language: string
): string {
  const zh = language.startsWith('zh');
  if (segment.state === 'running') return zh ? '工作中' : 'Working';
  if (segment.state === 'failed') return zh ? '失败' : 'Failed';
  if (segment.state === 'cancelled') return zh ? '已停止' : 'Stopped';
  if (segment.durationMs !== undefined) {
    const seconds = Math.max(1, Math.round(segment.durationMs / 1000));
    return zh ? `已工作 ${seconds} 秒` : `Worked for ${seconds}s`;
  }
  return zh ? '已工作' : 'Worked';
}
