import type { ConversationRow, ProductProjection } from '../core/types';
import type { SessionListRow } from './session-list';
import { presentStatusBar } from './status-bar';
import type {
  AgentTreeRow,
  StatusBarFacts,
  TuiReviewSnapshot,
  TuiRoute,
} from './types';
import {
  displayWidth,
  sanitizeSingleLine,
  truncateDisplay,
} from './text';

export interface TuiRenderSnapshot {
  route: TuiRoute;
  status: StatusBarFacts;
  activeSessionId?: string;
  activeSessionTitle: string;
  projection?: ProductProjection;
  sessions: SessionListRow[];
  selectedSessionId?: string;
  sessionQuery: string;
  agentRows: AgentTreeRow[];
  selectedAgentId?: string;
  agentFilter: string;
  composer: string;
  statusMessage?: string;
  prompt?: { label: string; value: string };
  review?: TuiReviewSnapshot;
}

export function renderTui(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(6, height);
  const status = truncateDisplay(
    presentStatusBar(view.status, safeWidth).text,
    safeWidth
  );
  const body = renderBody(view, safeWidth, safeHeight - 1);
  return [
    pad(status, safeWidth),
    ...body.map((line) =>
      pad(truncateDisplay(sanitizeSingleLine(line), safeWidth), safeWidth)
    ),
  ].slice(0, safeHeight);
}

function renderBody(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  if (view.route.kind === 'sessions') return renderSessions(view, width, height);
  if (view.route.kind === 'agents') return renderAgents(view, width, height);
  if (view.route.kind === 'status') return renderStatus(view, width, height);
  if (view.route.kind === 'help' || view.route.kind === 'commands') {
    return renderHelp(width, height);
  }
  if (view.route.kind === 'review') return renderReview(view, width, height);
  return renderConversation(view, width, height);
}

function renderConversation(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  const composer = view.prompt
    ? [`${view.prompt.label}${view.prompt.value}`]
    : wrapText(`> ${view.composer}`, width - 2).slice(0, Math.min(6, Math.max(1, height - 3)));
  const hint =
    height >= 12
      ? [view.statusMessage ?? 'Enter send · Ctrl+K sessions · Ctrl+G agents · ? help']
      : [];
  const available = Math.max(1, height - composer.length - hint.length);
  const transcript = view.projection
    ? renderRows(view.projection, width)
    : [`New session · ${view.activeSessionTitle}`, '', 'Type a task and press Enter.'];
  const clipped = transcript.slice(-available).map((line) => truncateDisplay(line, width));
  while (clipped.length < available) clipped.unshift('');
  return [...clipped, '', ...composer, ...hint].slice(-height);
}

function renderRows(projection: ProductProjection, width: number): string[] {
  const lines: string[] = [];
  for (const row of projection.rows) {
    lines.push(...renderRow(row, width));
  }
  if (!lines.length) lines.push('No messages yet.');
  if (
    projection.taskStatus === 'running' ||
    projection.taskStatus === 'queued' ||
    projection.taskStatus === 'waiting'
  ) {
    lines.push('', `Working · ${projection.phase} · queue ${projection.queueLength}`);
  }
  return lines;
}

function renderRow(row: ConversationRow, width: number): string[] {
  if (row.kind === 'user') return ['', ...wrapText(`> ${row.text}`, width)];
  if (row.kind === 'assistant') return wrapText(row.text || '…', width);
  if (row.kind === 'reasoning') {
    return [`  Thinking · ${truncateDisplay(sanitizeSingleLine(row.text), width - 13)}`];
  }
  if (row.kind === 'tool') {
    return [`  Tool · ${row.toolName ?? 'unknown'} · ${row.status}`];
  }
  return [`  ${row.kind === 'plan' ? 'Plan' : 'Activity'} · ${truncateDisplay(sanitizeSingleLine(row.text), width - 12)}`];
}

function renderSessions(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  const lines = [
    `Sessions · ${view.sessions.length}`,
    `/${view.sessionQuery}`,
    '',
  ];
  for (const session of view.sessions) {
    const selected = session.sessionId === view.selectedSessionId;
    lines.push(
      truncateDisplay(
        `${selected ? '>' : ' '} ${marker(session.marker)} ${session.title}  ${session.project}  ${session.status}  ${session.activity}`,
        width
      )
    );
  }
  if (!view.sessions.length) lines.push('No matching sessions.');
  while (lines.length < height - 1) lines.push('');
  lines.push('Enter switch · N new · R rename · D delete · Esc back');
  return lines.slice(-height);
}

function renderAgents(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  const lines = [
    `Agents · ${view.agentRows.length} · ${view.agentFilter.toUpperCase()}`,
    '',
  ];
  if (!view.agentRows.length) {
    lines.push('No child agents in this session.', '', 'Press Esc to return.');
  }
  for (const row of view.agentRows) {
    const selected = row.agent.taskId === view.selectedAgentId;
    lines.push(
      truncateDisplay(
        `${selected ? '>' : ' '} ${'  '.repeat(row.depth)}${row.agent.profileName} · ${row.agent.status} · ${row.agent.executionMode}${row.agent.summary ? ` · ${row.agent.summary}` : ''}`,
        width
      )
    );
  }
  if (view.statusMessage) lines.push('', view.statusMessage);
  while (lines.length < height - 1) lines.push('');
  lines.push('Enter view · S stop · M merge preview · A apply merge · F filter · Esc back');
  return lines.slice(-height);
}

function renderStatus(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  const projection = view.projection;
  const lines = [
    'Runtime status',
    `Session       ${view.activeSessionTitle} (${view.activeSessionId ?? 'local draft'})`,
    `Task          ${projection?.taskStatus ?? 'draft'}`,
    `Phase         ${projection?.phase ?? '-'}`,
    `Revision      ${projection?.revision ?? 0}`,
    `Event seq     ${projection?.eventSeq ?? 0}`,
    `Queue         ${projection?.queueLength ?? 0}`,
    `Permission    ${projection?.permissionMode ?? '-'}`,
    `Agents        ${projection?.children?.length ?? 0}`,
    `Workspace     ${view.status.project ?? '-'} ${view.status.branch ?? ''}`,
    `Model         ${view.status.model ?? '-'}`,
    `Provider      ${view.status.provider ?? '-'}`,
    `Last error    ${projection?.lastError?.message ?? '-'}`,
    '',
    'Esc back',
  ].map((line) => truncateDisplay(line, width));
  return lines.slice(0, height);
}

function renderReview(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  if (view.review) {
    const additions = view.review.additions ?? countPatch(view.review, '+');
    const deletions = view.review.deletions ?? countPatch(view.review, '-');
    const lines = [
      `Review · ${view.activeSessionTitle} · ${view.review.files.length} files · +${additions}/-${deletions}`,
      ...(view.review.verification?.length
        ? view.review.verification.map(
            (check) =>
              `Verify · ${check.name} · ${check.status}${check.detail ? ` · ${check.detail}` : ''}`
          )
        : ['Verification · runtime output is shown in the conversation']),
      '',
      ...view.review.files.flatMap((file) => [
        `${file.status.toUpperCase()} ${file.path}`,
        ...(file.patch
          ? file.patch
              .split('\n')
              .filter((line) => line.startsWith('@@') || line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))
              .slice(0, 20)
          : ['Binary or metadata-only change']),
      ]),
      ...(view.review.risks?.length
        ? ['', ...view.review.risks.map((risk) => `Risk · ${risk}`)]
        : []),
      '',
      'Read-only review · Esc back',
    ];
    return lines.map((line) => truncateDisplay(line, width)).slice(0, height);
  }
  const lines = [
    `Review · ${view.activeSessionTitle}`,
    '',
    'Workspace Diff        unavailable',
    'Verification          runtime-owned',
    'Risks                 see final answer',
    '',
    'This view is read-only in the first TUI milestone.',
    'Esc back',
  ].map((line) => truncateDisplay(line, width));
  while (lines.length < height) lines.push('');
  return lines;
}

function countPatch(review: TuiReviewSnapshot, prefix: string): number {
  return review.files.reduce(
    (count, file) =>
      count +
      (file.patch?.split('\n').filter((line) => line.startsWith(prefix)).length ?? 0),
    0
  );
}

function renderHelp(width: number, height: number): string[] {
  const lines = [
    'Keyboard',
    '',
    'Enter             send / activate',
    'Shift+Enter/Ctrl+J newline',
    'Ctrl+C            stop task, twice to exit when idle',
    'Ctrl+K            sessions',
    'Ctrl+G            agent board',
    'Ctrl+I            full status',
    'Ctrl+O            review',
    'Ctrl+P            commands / help',
    'Esc               back',
    '',
    'Esc back',
  ].map((line) => truncateDisplay(line, width));
  while (lines.length < height) lines.push('');
  return lines.slice(0, height);
}

function marker(value: SessionListRow['marker']): string {
  if (value === 'current') return '●';
  if (value === 'running') return '◐';
  if (value === 'attention') return '!';
  return '○';
}

function wrapText(value: string, width: number): string[] {
  const max = Math.max(1, width);
  const lines: string[] = [];
  for (const paragraph of value.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let rest = paragraph;
    while (displayWidth(rest) > max) {
      let cut = Math.max(1, max);
      let candidate = truncateDisplay(rest, cut);
      if (candidate.endsWith('…')) candidate = candidate.slice(0, -1);
      if (!candidate) break;
      lines.push(candidate);
      rest = rest.slice(candidate.length);
    }
    lines.push(rest);
  }
  return lines;
}

function pad(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - displayWidth(value)))}`;
}
