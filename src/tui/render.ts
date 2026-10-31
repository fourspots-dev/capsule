import type { ConversationRow, ProductProjection } from '../core/types';
import { renderPanel, blankLine } from './components';
import {
  indentStyledLine,
  renderDiffLine,
  renderMarkdown,
  wrapStyledLine,
} from './format';
import type { SessionListRow } from './session-list';
import { presentStatusBar } from './status-bar';
import {
  detectThemeOptions,
  padStyledLine,
  plainStyledLine,
  renderAnsiLine,
  styledLine,
  styledLineWidth,
  styledLineText,
  styleSpan,
  truncateStyledLine,
  type StyledLine,
  type ThemeOptions,
  type ThemeToken,
  type TextStyle,
} from './styled';
import { displayWidth, sanitizeSingleLine, truncateDisplay } from './text';
import type {
  AgentTreeRow,
  ReasoningMode,
  StatusBarFacts,
  TuiReviewSnapshot,
  TuiRoute,
} from './types';

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
  composerCursor: number;
  reasoningMode: ReasoningMode;
  statusMessage?: string;
  prompt?: { label: string; value: string };
  review?: TuiReviewSnapshot;
}

export interface TuiCursorTarget {
  row: number;
  column: number;
  visible: boolean;
  shape: 'bar' | 'block';
}

export interface TuiRenderedFrame {
  lines: string[];
  cursor: TuiCursorTarget;
}

export function renderTui(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): string[] {
  return renderTuiDocument(view, width, height).map(styledLineText);
}

export function renderTuiAnsi(
  view: TuiRenderSnapshot,
  width: number,
  height: number,
  options: ThemeOptions = detectThemeOptions()
): string[] {
  return renderTuiFrame(view, width, height, options).lines;
}

export function renderTuiFrame(
  view: TuiRenderSnapshot,
  width: number,
  height: number,
  options: ThemeOptions = detectThemeOptions()
): TuiRenderedFrame {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(6, height);
  return {
    lines: renderTuiDocument(view, safeWidth, safeHeight).map((line) =>
      renderAnsiLine(line, safeWidth, options)
    ),
    cursor: cursorTarget(view, safeWidth, safeHeight),
  };
}

export function renderTuiDocument(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const safeWidth = Math.max(20, width);
  const safeHeight = Math.max(6, height);
  const lines = [
    renderStatusBar(view, safeWidth),
    ...renderBody(view, safeWidth, safeHeight - 1),
  ];
  return fitVertical(
    lines.map((line) => padStyledLine(line, safeWidth)),
    safeHeight
  );
}

function renderBody(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  if (view.route.kind === 'sessions') return renderSessions(view, width, height);
  if (view.route.kind === 'agents') return renderAgents(view, width, height);
  if (view.route.kind === 'status') return renderStatus(view, width, height);
  if (view.route.kind === 'help' || view.route.kind === 'commands') {
    return renderHelp(width, height);
  }
  if (view.route.kind === 'review') return renderReview(view, width, height);
  return renderConversation(view, width, height);
}

function renderStatusBar(view: TuiRenderSnapshot, width: number): StyledLine {
  const presentation = presentStatusBar(view.status, Math.max(1, width - 2));
  const spans = [styleSpan('◆ ', { fg: 'accent', bold: true })];
  presentation.segments.forEach((segment, index) => {
    if (index) spans.push(styleSpan(' · ', { fg: 'border', dim: true }));
    spans.push(
      styleSpan(segment.text, statusSegmentStyle(segment.key, view.status))
    );
  });
  return truncateStyledLine({ spans }, width);
}

function statusSegmentStyle(
  key: string,
  facts: StatusBarFacts
): { fg: ThemeToken; bold?: boolean; dim?: boolean } {
  if (key === 'blockers') return { fg: 'error', bold: true };
  if (key === 'task') {
    if (facts.taskStatus === 'failed') return { fg: 'error', bold: true };
    if (facts.taskStatus === 'waiting' || facts.taskStatus === 'queued') {
      return { fg: 'warning', bold: true };
    }
    if (facts.taskStatus === 'completed') return { fg: 'success', bold: true };
    if (facts.taskStatus === 'running') return { fg: 'accent', bold: true };
  }
  if (key === 'session') return { fg: 'text', bold: true };
  if (key === 'workspace') return { fg: facts.dirty ? 'warning' : 'muted' };
  if (key === 'activity') return { fg: 'tool' };
  if (key === 'environment') return { fg: 'muted', dim: true };
  return { fg: 'muted' };
}

function renderConversation(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const useContext = width >= 108 && height - 1 >= 20;
  const contextWidth = useContext
    ? Math.min(36, Math.max(28, Math.floor(width * 0.27)))
    : 0;
  const mainWidth = useContext ? width - contextWidth - 1 : width;
  const hint = height >= 12 ? renderHint(view, mainWidth) : [];
  const composer = renderComposer(view, mainWidth);
  const transcriptHeight = Math.max(1, height - composer.length - hint.length);
  const transcript = renderTranscript(
    view.projection,
    mainWidth,
    transcriptHeight,
    view.reasoningMode,
    view
  );
  const main = fitVertical(
    [...transcript, ...composer, ...hint].map((line) =>
      padStyledLine(line, mainWidth)
    ),
    height
  );
  if (!useContext) return main;
  const context = renderContextPanel(view, contextWidth, height);
  return main.map((line, index) =>
    styledLine(
      ...line.spans,
      styleSpan('│', { fg: 'border' }),
      ...padStyledLine(context[index] ?? blankLine(), contextWidth).spans
    )
  );
}

function renderHint(view: TuiRenderSnapshot, width: number): StyledLine[] {
  const text =
    view.statusMessage ??
    `Enter send · Ctrl+T think:${view.reasoningMode} · Ctrl+K sessions · Ctrl+G agents · ? help`;
  return [plainStyledLine(truncateDisplay(text, width), { fg: 'muted', dim: true })];
}

function renderComposer(view: TuiRenderSnapshot, width: number): StyledLine[] {
  const layout = composerLayout(view, width);
  return renderPanel({
    title: view.prompt ? 'CONFIRM' : 'PROMPT',
    badge: view.prompt ? 'Enter accept · Esc cancel' : view.reasoningMode,
    width,
    lines: layout.lines,
    token: view.prompt ? 'warning' : 'accent',
    focused: true,
  });
}

interface ComposerLayout {
  lines: StyledLine[];
  cursorLine: number;
  cursorColumn: number;
}

function composerLayout(view: TuiRenderSnapshot, width: number): ComposerLayout {
  const innerWidth = Math.max(1, width - 4);
  if (view.prompt) {
    return wrapComposerCursor(
      view.prompt.label,
      view.prompt.value,
      view.prompt.value.length,
      innerWidth,
      { fg: 'warning', bold: true },
      { fg: 'text' }
    );
  }
  return wrapComposerCursor(
    '> ',
    view.composer,
    Math.max(0, Math.min(view.composer.length, view.composerCursor)),
    innerWidth,
    { fg: 'accent', bold: true },
    { fg: 'text' }
  );
}

function wrapComposerCursor(
  prefix: string,
  value: string,
  cursorOffset: number,
  width: number,
  prefixStyle: TextStyle,
  textStyle: TextStyle
): ComposerLayout {
  const build = (text: string): StyledLine[] =>
    text.split('\n').flatMap((part, index) =>
      wrapStyledLine(
        styledLine(
          styleSpan(index === 0 ? prefix : '', prefixStyle),
          styleSpan(part, textStyle)
        ),
        width,
        true
      )
    );
  const all = build(value);
  const before = build(
    value.slice(0, Math.max(0, Math.min(value.length, cursorOffset)))
  );
  let cursorLine = Math.max(0, before.length - 1);
  let cursorColumn = styledLineWidth(before.at(-1) ?? plainStyledLine(''));
  if (cursorLine >= all.length) {
    all.push(blankLine());
    cursorLine = all.length - 1;
  }
  const maxRows = 4;
  const start = Math.max(
    0,
    Math.min(cursorLine - maxRows + 1, Math.max(0, all.length - maxRows))
  );
  const lines = all.slice(start, start + maxRows);
  cursorLine -= start;
  while (lines.length < 1) lines.push(blankLine());
  cursorLine = Math.max(0, Math.min(cursorLine, lines.length - 1));
  cursorColumn = Math.max(0, Math.min(cursorColumn, width));
  return { lines, cursorLine, cursorColumn };
}

function cursorTarget(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): TuiCursorTarget {
  if (view.route.kind === 'sessions') {
    return {
      row: 3,
      column: 12 + displayWidth(view.sessionQuery),
      visible: true,
      shape: 'block',
    };
  }
  if (view.route.kind !== 'conversation') {
    return { row: 1, column: 1, visible: false, shape: 'block' };
  }
  const useContext = width >= 108 && height >= 20;
  const contextWidth = useContext
    ? Math.min(36, Math.max(28, Math.floor(width * 0.27)))
    : 0;
  const mainWidth = useContext ? width - contextWidth - 1 : width;
  const bodyHeight = height - 1;
  const hintHeight = bodyHeight >= 12 ? 1 : 0;
  const layout = composerLayout(view, mainWidth);
  const panelHeight = layout.lines.length + 2;
  const composerStart = Math.max(0, bodyHeight - hintHeight - panelHeight);
  return {
    row: 3 + composerStart + layout.cursorLine,
    column: 3 + layout.cursorColumn,
    visible: true,
    shape: 'block',
  };
}

function renderTranscript(
  projection: ProductProjection | undefined,
  width: number,
  height: number,
  reasoningMode: ReasoningMode,
  view: TuiRenderSnapshot
): StyledLine[] {
  if (!projection) {
    return fitVertical(
      renderPanel({
        title: 'NEW SESSION',
        badge: view.activeSessionTitle,
        width,
        lines: [
          plainStyledLine('Type a task and press Enter.', { fg: 'text' }),
          plainStyledLine(
            'The agent will show reasoning, tools, diffs and verification as they happen.',
            { fg: 'muted' }
          ),
        ],
        token: 'accent',
      }),
      height
    );
  }
  const rendered: StyledLine[] = [];
  const finalAssistantIds = collectFinalAssistantIds(
    projection.rows,
    projection.activeTaskId
  );
  const recentStart = Math.max(0, projection.rows.length - 80);
  let previousKind: ConversationRow['kind'] | undefined;
  for (let index = recentStart; index < projection.rows.length; index += 1) {
    const row = projection.rows[index];
    if (
      row.kind === 'assistant' &&
      row.status === 'completed' &&
      !row.text.trim()
    ) {
      continue;
    }
    if (
      row.kind === 'activity' &&
      /^thinking(?:\s+complete)?$/i.test(row.text.trim())
    ) {
      continue;
    }
    if (previousKind && needsTurnGap(previousKind, row.kind)) {
      rendered.push(blankLine());
    }
    const rowLines = renderRow(
      row,
      width,
      reasoningMode,
      finalAssistantIds.has(row.id)
    );
    if (rowLines.length) rendered.push(...rowLines);
    previousKind = row.kind;
  }
  const hasActiveOutput = projection.rows.some(
    (row) =>
      row.status === 'streaming' &&
      (row.kind === 'assistant' ||
        row.kind === 'reasoning' ||
        row.kind === 'tool')
  );
  if (
    ['running', 'queued', 'waiting'].includes(projection.taskStatus) &&
    !hasActiveOutput
  ) {
    rendered.push(
      plainStyledLine(
        `◌ ${projection.taskStatus === 'queued' ? 'Queued' : 'Waiting for model'} · ${projection.phase} · queue ${projection.queueLength}`,
        { fg: 'warning', dim: true }
      )
    );
  }
  if (!rendered.length) {
    rendered.push(
      plainStyledLine('No messages yet.', { fg: 'muted' }),
      plainStyledLine('Type a task below.', { fg: 'muted', dim: true })
    );
  }
  return fitVertical(rendered.slice(-height), height);
}

function renderRow(
  row: ConversationRow,
  width: number,
  reasoningMode: ReasoningMode,
  finalAssistant: boolean
): StyledLine[] {
  if (row.kind === 'user') {
    return [
      styledLine(
        styleSpan('▌ YOU', { fg: 'accent', bold: true }),
        styleSpan(`  ${relativeTime(row.startedAt)}`, {
          fg: 'muted',
          dim: true,
        })
      ),
      ...transcriptMarkdown(row.text, Math.max(1, width - 2)).map((line) =>
        indentStyledLine(line, '  ', { fg: 'accent' })
      ),
    ];
  }
  if (row.kind === 'assistant') {
    const label = finalAssistant ? '◆ RESULT' : '· TINYAI';
    return [
      styledLine(
        styleSpan(label, {
          fg: finalAssistant ? 'accent' : 'muted',
          bold: finalAssistant,
        }),
        styleSpan(displaySuffix(row), toolStatusStyle(row.status))
      ),
      ...transcriptMarkdown(row.text || '…', Math.max(1, width - 2)).map((line) =>
        indentStyledLine(
          finalAssistant ? line : mutedStyledLine(line),
          '  ',
          { fg: 'muted' }
        )
      ),
    ];
  }
  if (row.kind === 'reasoning') {
    return renderReasoning(row, width, reasoningMode);
  }
  if (row.kind === 'tool') {
    return renderTool(row, width);
  }
  if (row.kind === 'plan') {
    return indentLines(
      renderPanel({
        title: 'PLAN',
        badge: row.status,
        width: Math.max(8, width - 2),
        lines: renderMarkdown(boundedDisplayText(row.text, 12_000), Math.max(1, width - 6)).slice(-6),
        token: 'accent',
        maxHeight: 6,
      }),
      '  ',
      { fg: 'muted' }
    );
  }
  return indentLines(
    [
      styledLine(
        styleSpan('· ', { fg: 'muted' }),
        styleSpan(sanitizeSingleLine(row.text), { fg: 'muted', dim: true }),
        styleSpan(`  ${row.status}`, toolStatusStyle(row.status))
      ),
    ],
    '  ',
    { fg: 'muted' }
  );
}

function renderReasoning(
  row: ConversationRow,
  width: number,
  mode: ReasoningMode
): StyledLine[] {
  const duration = rowDuration(row);
  const size = displayWidth(row.text);
  if (mode === 'hidden') {
    return indentLines(
      [
        plainStyledLine(
          `▸ Thought · ${size} chars${duration ? ` · ${duration}` : ''} · Ctrl+T to show`,
          { fg: 'reasoning', dim: true }
        ),
      ],
      '  ',
      { fg: 'muted' }
    );
  }
  if (mode === 'preview' && row.status === 'completed') {
    return indentLines(
      [
        plainStyledLine(
          `▸ Thought · ${size} chars${duration ? ` · ${duration}` : ''} · Ctrl+T to expand`,
          { fg: 'reasoning', dim: true }
        ),
      ],
      '  ',
      { fg: 'muted' }
    );
  }
  const panelWidth = Math.max(8, width - 2);
  const body = renderMarkdown(
    boundedDisplayText(row.text),
    Math.max(1, panelWidth - 4)
  );
  const preview = mode === 'preview' ? body.slice(-6) : body.slice(-14);
  return indentLines(
    renderPanel({
      title: row.status === 'streaming' ? 'THINKING' : 'THOUGHT',
      badge:
        row.status === 'streaming'
          ? `live${duration ? ` ${duration}` : ''}`
          : `${size} chars${duration ? ` · ${duration}` : ''}`,
      width: panelWidth,
      lines: preview.length ? preview : [plainStyledLine('…', { fg: 'muted' })],
      token: 'reasoning',
      maxHeight: mode === 'preview' ? 6 : 14,
    }),
    '  ',
    { fg: 'muted' }
  );
}

function renderTool(row: ConversationRow, width: number): StyledLine[] {
  const style = toolStatusStyle(row.status);
  const summary = toolSummary(row);
  if (
    row.status === 'failed' ||
    row.status === 'denied' ||
    row.status === 'streaming'
  ) {
    const panelWidth = Math.max(8, width - 4);
    return indentLines(
      renderPanel({
        title: row.toolName ?? 'tool',
        badge: `${row.status}${rowDuration(row) ? ` · ${rowDuration(row)}` : ''}`,
        width: panelWidth,
        lines: wrapStyledLine(
          plainStyledLine(summary, {
            fg:
              row.status === 'failed' || row.status === 'denied'
                ? 'error'
                : 'muted',
          }),
          Math.max(1, panelWidth - 4)
        ).slice(-4),
        token:
          row.status === 'failed' || row.status === 'denied' ? 'error' : 'tool',
        maxHeight: 4,
      }),
      '    ',
      { fg: 'border' }
    );
  }
  return indentLines(
    [
      styledLine(
        styleSpan(
          row.status === 'completed'
            ? '✓ '
            : row.status === 'cancelled'
              ? '■ '
              : '● ',
          style
        ),
        styleSpan(row.toolName ?? 'tool', { ...style, bold: true }),
        styleSpan(`  ${summary}`, { fg: 'muted' }),
        styleSpan(rowDuration(row) ? `  ${rowDuration(row)}` : '', {
          fg: 'muted',
          dim: true,
        })
      ),
    ],
    '    ',
    { fg: 'border' }
  ).map((line) => truncateStyledLine(line, width));
}

function toolSummary(row: ConversationRow): string {
  const parsedValue =
    row.text.length <= 128_000 ? parseJsonValue(row.text) : undefined;
  if (Array.isArray(parsedValue)) {
    return `${parsedValue.length} result${parsedValue.length === 1 ? '' : 's'}`;
  }
  const parsed =
    parsedValue && typeof parsedValue === 'object'
      ? (parsedValue as Record<string, unknown>)
      : undefined;
  if (parsed) {
    if (typeof parsed.exitCode === 'number') {
      const stdout = typeof parsed.stdout === 'string' ? parsed.stdout : '';
      const stderr = typeof parsed.stderr === 'string' ? parsed.stderr : '';
      const first = (stdout || stderr).trim().split('\n').find(Boolean);
      return `exit ${parsed.exitCode}${first ? ` · ${sanitizeSingleLine(first)}` : ''}`;
    }
    if (typeof parsed.path === 'string') {
      const bytes =
        typeof parsed.bytes === 'number' ? ` · ${parsed.bytes} bytes` : '';
      return `${parsed.path}${bytes}`;
    }
    if (Array.isArray(parsed.files)) {
      const additions =
        typeof parsed.additions === 'number' ? parsed.additions : 0;
      const deletions =
        typeof parsed.deletions === 'number' ? parsed.deletions : 0;
      return `${parsed.files.length} file${parsed.files.length === 1 ? '' : 's'} · +${additions}/-${deletions}`;
    }
    if (typeof parsed.error === 'object' && parsed.error) {
      const error = parsed.error as { message?: unknown; code?: unknown };
      return sanitizeSingleLine(String(error.message ?? error.code ?? 'error'));
    }
  }
  return (
    truncateDisplay(
      sanitizeSingleLine(boundedDisplayText(row.text, 4_000)),
      72
    ) || row.status
  );
}

function renderContextPanel(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const projection = view.projection;
  const body: StyledLine[] = [];
  body.push(plainStyledLine('TASK', { fg: 'accent', bold: true }));
  body.push(
    styledLine(
      styleSpan(
        statusGlyph(projection?.taskStatus),
        toolStatusStyle(projection?.taskStatus)
      ),
      styleSpan(` ${projection?.taskStatus ?? 'draft'}`, {
        ...toolStatusStyle(projection?.taskStatus),
      }),
      styleSpan(`  q${projection?.queueLength ?? 0}`, { fg: 'muted' })
    )
  );
  if (view.status.model) {
    body.push(
      plainStyledLine(truncateDisplay(view.status.model, width - 4), {
        fg: 'muted',
      })
    );
  }
  body.push(
    blankLine(),
    plainStyledLine('AGENTS', { fg: 'accent', bold: true })
  );
  const children = projection?.children ?? [];
  if (!children.length) {
    body.push(plainStyledLine('none', { fg: 'muted', dim: true }));
  } else {
    for (const child of children.slice(-5)) {
      body.push(
        styledLine(
          styleSpan(statusGlyph(child.status), toolStatusStyle(child.status)),
          styleSpan(` ${child.profileName}`, { fg: 'text', bold: true }),
          styleSpan(`  ${child.executionMode}`, { fg: 'muted', dim: true })
        )
      );
      if (child.summary) {
        body.push(
          indentStyledLine(
            plainStyledLine(
              truncateDisplay(child.summary, Math.max(1, width - 6)),
              { fg: 'muted' }
            ),
            '  '
          )
        );
      }
    }
  }
  const changes = changedWorkspaceCount(projection);
  body.push(
    blankLine(),
    plainStyledLine('WORKSPACE', { fg: 'accent', bold: true })
  );
  body.push(
    plainStyledLine(
      changes
        ? `${changes} file-changing tool${changes === 1 ? '' : 's'}`
        : 'waiting for changes',
      { fg: changes ? 'file' : 'muted' }
    )
  );
  body.push(
    plainStyledLine(
      `${shortSession(view.activeSessionId)} · rev ${projection?.revision ?? 0}`,
      { fg: 'muted', dim: true }
    )
  );
  while (body.length < Math.max(1, height - 2)) body.push(blankLine());
  return fitVertical(
    renderPanel({
      title: 'CONTEXT',
      badge: 'Ctrl+B',
      width,
      lines: body.slice(0, Math.max(1, height - 2)),
      token: 'border',
    }),
    height
  );
}

function renderSessions(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const body: StyledLine[] = [
    styledLine(
      styleSpan('SEARCH ', { fg: 'muted', bold: true }),
      styleSpan(`/${view.sessionQuery}`, { fg: 'text' })
    ),
    blankLine(),
  ];
  if (!view.sessions.length) {
    body.push(plainStyledLine('No matching sessions.', { fg: 'muted' }));
  }
  for (const session of view.sessions) {
    const selected = session.sessionId === view.selectedSessionId;
    body.push(
      styledLine(
        styleSpan(selected ? '› ' : '  ', { fg: 'accent', bold: true }),
        styleSpan(marker(session.marker), statusMarkerStyle(session.marker)),
        styleSpan(` ${session.title}`, {
          fg: selected ? 'accent' : 'text',
          bold: selected,
        }),
        styleSpan(`  ${session.project ?? ''}`, { fg: 'muted' }),
        styleSpan(`  ${session.status}`, toolStatusStyle(session.status)),
        styleSpan(`  ${session.activity}`, { fg: 'muted', dim: true })
      )
    );
  }
  while (body.length < Math.max(1, height - 3)) body.push(blankLine());
  return fitVertical(
    renderPanel({
      title: 'Sessions',
      badge: String(view.sessions.length),
      width,
      lines: body.slice(0, Math.max(1, height - 3)),
      token: 'accent',
      footer: 'Enter switch · N new · R rename · D delete · Esc back',
    }),
    height
  );
}

function renderAgents(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const body: StyledLine[] = [
    styledLine(
      styleSpan('FILTER ', { fg: 'muted', bold: true }),
      styleSpan(view.agentFilter.toUpperCase(), { fg: 'accent', bold: true }),
      styleSpan(`  ${view.agentRows.length} visible`, { fg: 'muted' })
    ),
    blankLine(),
  ];
  if (!view.agentRows.length) {
    body.push(
      plainStyledLine('No child agents in this session.', { fg: 'muted' }),
      plainStyledLine('Agents are generic profiles, not fixed roles.', {
        fg: 'muted',
        dim: true,
      })
    );
  }
  for (const row of view.agentRows) {
    const selected = row.agent.taskId === view.selectedAgentId;
    body.push(
      styledLine(
        styleSpan(selected ? '› ' : '  ', { fg: 'accent', bold: true }),
        styleSpan('  '.repeat(row.depth), { fg: 'border' }),
        styleSpan(
          statusGlyph(row.agent.status),
          toolStatusStyle(row.agent.status)
        ),
        styleSpan(` ${row.agent.profileName}`, {
          fg: selected ? 'accent' : 'text',
          bold: true,
        }),
        styleSpan(`  ${row.agent.executionMode}`, { fg: 'muted' }),
        styleSpan(row.agent.summary ? `  ${row.agent.summary}` : '', {
          fg: 'muted',
          dim: true,
        })
      )
    );
  }
  if (view.statusMessage) {
    body.push(blankLine(), plainStyledLine(view.statusMessage, { fg: 'warning' }));
  }
  while (body.length < Math.max(1, height - 3)) body.push(blankLine());
  return fitVertical(
    renderPanel({
      title: 'AGENTS',
      badge: 'generic profiles',
      width,
      lines: body.slice(0, Math.max(1, height - 3)),
      token: 'accent',
      footer: 'Enter inspect · S stop · F filter · M preview merge · Esc back',
    }),
    height
  );
}

function renderStatus(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const projection = view.projection;
  const entries: Array<[string, string, ThemeToken?]> = [
    [
      'Session',
      `${view.activeSessionTitle} (${view.activeSessionId ?? 'local draft'})`,
    ],
    [
      'Task',
      projection?.taskStatus ?? 'draft',
      toolStatusStyle(projection?.taskStatus).fg,
    ],
    ['Phase', projection?.phase ?? '-'],
    ['Revision', String(projection?.revision ?? 0)],
    ['Event seq', String(projection?.eventSeq ?? 0)],
    ['Queue', String(projection?.queueLength ?? 0)],
    ['Permission', projection?.permissionMode ?? '-'],
    ['Agents', String(projection?.children?.length ?? 0)],
    ['Workspace', `${view.status.project ?? '-'} ${view.status.branch ?? ''}`],
    ['Model', view.status.model ?? '-'],
    ['Provider', view.status.provider ?? '-'],
    [
      'Last error',
      projection?.lastError?.message ?? '-',
      projection?.lastError ? 'error' : undefined,
    ],
  ];
  const body = entries.map(([key, value, token]) =>
    styledLine(
      styleSpan(key.padEnd(12), { fg: 'muted', bold: true }),
      styleSpan(value, { fg: token ?? 'text' })
    )
  );
  return fitVertical(
    renderPanel({
      title: 'RUNTIME STATUS',
      width,
      lines: body,
      token: 'accent',
      footer: 'Esc back',
    }),
    height
  );
}

function renderReview(
  view: TuiRenderSnapshot,
  width: number,
  height: number
): StyledLine[] {
  const review = view.review;
  if (!review) {
    return fitVertical(
      renderPanel({
        title: 'REVIEW',
        badge: view.activeSessionTitle,
        width,
        lines: [
          plainStyledLine('Workspace Diff        unavailable', { fg: 'muted' }),
          plainStyledLine('Verification          runtime-owned', {
            fg: 'muted',
          }),
          plainStyledLine('Risks                 see final answer', {
            fg: 'muted',
          }),
          blankLine(),
          plainStyledLine('This view is read-only in the first TUI milestone.', {
            fg: 'warning',
          }),
        ],
        token: 'warning',
        footer: 'Esc back',
      }),
      height
    );
  }
  const additions = review.additions ?? countPatch(review, '+');
  const deletions = review.deletions ?? countPatch(review, '-');
  const body: StyledLine[] = [
    styledLine(
      styleSpan(`${review.files.length} files`, { fg: 'text', bold: true }),
      styleSpan(`  +${additions}/-${deletions}`, {
        fg: additions || !deletions ? 'added' : 'removed',
        bold: true,
      })
    ),
  ];
  if (review.verification?.length) {
    body.push(
      blankLine(),
      plainStyledLine('VERIFICATION', { fg: 'accent', bold: true })
    );
    for (const check of review.verification) {
      body.push(
        styledLine(
          styleSpan(
            check.status === 'passed'
              ? '✓ '
              : check.status === 'failed'
                ? '✗ '
                : '○ ',
            {
              fg:
                check.status === 'passed'
                  ? 'success'
                  : check.status === 'failed'
                    ? 'error'
                    : 'muted',
            }
          ),
          styleSpan(check.name, { fg: 'text', bold: true }),
          styleSpan(check.detail ? ` · ${check.detail}` : '', { fg: 'muted' })
        )
      );
    }
  }
  for (const file of review.files) {
    body.push(
      blankLine(),
      styledLine(
        styleSpan(file.status.toUpperCase(), {
          fg:
            file.status === 'added'
              ? 'added'
              : file.status === 'deleted'
                ? 'removed'
                : 'file',
          bold: true,
        }),
        styleSpan(` ${file.path}`, { fg: 'text', bold: true })
      )
    );
    const patch = file.patch
      ? file.patch
          .split('\n')
          .filter(
            (line) =>
              line.startsWith('@@') ||
              line.startsWith('+') ||
              line.startsWith('-') ||
              line.startsWith(' ')
          )
          .slice(0, 18)
      : ['Binary or metadata-only change'];
    body.push(...patch.map(renderDiffLine));
  }
  if (review.risks?.length) {
    body.push(
      blankLine(),
      plainStyledLine('RISKS', { fg: 'warning', bold: true })
    );
    body.push(
      ...review.risks.map((risk) =>
        plainStyledLine(`! ${risk}`, { fg: 'warning' })
      )
    );
  }
  while (body.length < Math.max(1, height - 3)) body.push(blankLine());
  return fitVertical(
    renderPanel({
      title: 'REVIEW',
      badge: `${review.from} → ${review.to}`,
      width,
      lines: body.slice(0, Math.max(1, height - 3)),
      token: 'accent',
      footer: 'Read-only review · Esc back',
    }),
    height
  );
}

function renderHelp(width: number, height: number): StyledLine[] {
  const keys: Array<[string, string]> = [
    ['Enter', 'send / activate'],
    ['Shift+Enter / Ctrl+J', 'newline'],
    ['Ctrl+C', 'stop task; twice when idle to exit'],
    ['Ctrl+T', 'reasoning hidden / preview / full'],
    ['Ctrl+K', 'sessions'],
    ['Ctrl+G', 'agent board'],
    ['Ctrl+I', 'full status'],
    ['Ctrl+O', 'review'],
    ['Ctrl+P', 'commands / help'],
    ['Esc', 'back'],
  ];
  const body = keys.map(([key, description]) =>
    styledLine(
      styleSpan(key.padEnd(22), { fg: 'accent', bold: true }),
      styleSpan(description, { fg: 'text' })
    )
  );
  return fitVertical(
    renderPanel({
      title: 'KEYBOARD',
      width,
      lines: body,
      token: 'accent',
      footer: 'Esc back',
    }),
    height
  );
}

function fitVertical(lines: StyledLine[], height: number): StyledLine[] {
  const result = lines.slice(0, height);
  while (result.length < height) result.push(blankLine());
  return result;
}

function collectFinalAssistantIds(
  rows: readonly ConversationRow[],
  activeTaskId?: string
): Set<string> {
  const finals = new Map<string, string>();
  for (const row of rows) {
    if (row.productTurnId === activeTaskId) continue;
    if (row.kind === 'assistant' && row.status === 'completed') {
      finals.set(row.productTurnId, row.id);
    }
  }
  return new Set(finals.values());
}

function needsTurnGap(
  previous: ConversationRow['kind'],
  current: ConversationRow['kind']
): boolean {
  if (current === 'tool' || current === 'activity') return false;
  if (current === 'reasoning' && previous === 'assistant') return false;
  if (previous === 'tool' && current === 'reasoning') return false;
  return (
    current === 'user' ||
    current === 'assistant' ||
    current === 'plan'
  );
}

function indentLines(
  lines: readonly StyledLine[],
  prefix: string,
  style: TextStyle = {}
): StyledLine[] {
  return lines.map((line) => indentStyledLine(line, prefix, style));
}

function mutedStyledLine(line: StyledLine): StyledLine {
  return {
    spans: line.spans.map((span) => ({
      ...span,
      style: {
        ...span.style,
        fg: span.style.bold ? 'text' : 'muted',
        dim: span.style.bold ? span.style.dim : true,
      },
    })),
  };
}

function boundedDisplayText(value: string, maxChars = 24_000): string {
  if (value.length <= maxChars) return value;
  return `… ${value.length - maxChars} earlier characters omitted …\n\n${value.slice(-maxChars)}`;
}

function transcriptMarkdown(
  value: string,
  width: number,
  maxLines = 18
): StyledLine[] {
  const lines = renderMarkdown(boundedDisplayText(value), width);
  if (lines.length <= maxLines) return lines;
  return [
    plainStyledLine(
      `… ${lines.length - maxLines + 1} earlier display lines · Enter for full history`,
      { fg: 'muted', dim: true }
    ),
    ...lines.slice(-(maxLines - 1)),
  ];
}

function toolStatusStyle(
  status:
    | ConversationRow['status']
    | ProductProjection['taskStatus']
    | AgentTreeRow['agent']['status']
    | SessionListRow['status']
    | undefined
): { fg: ThemeToken; bold?: boolean } {
  if (status === 'failed' || status === 'denied') {
    return { fg: 'error', bold: true };
  }
  if (status === 'cancelled') return { fg: 'muted' };
  if (status === 'completed') return { fg: 'success' };
  if (status === 'streaming' || status === 'running') {
    return { fg: 'accent', bold: true };
  }
  if (
    status === 'pending' ||
    status === 'queued' ||
    status === 'waiting'
  ) {
    return { fg: 'warning', bold: true };
  }
  return { fg: 'muted' };
}

function statusSuffix(row: ConversationRow): string {
  if (row.status === 'streaming') return '  · streaming';
  if (row.status === 'failed') return '  · failed';
  return '';
}

function displaySuffix(row: ConversationRow): string {
  const status = statusSuffix(row);
  if (row.text.length <= 24_000) return status;
  return `${status}  · ${row.text.length - 24_000} chars clipped`;
}

function statusGlyph(status: string | undefined): string {
  if (status === 'completed') return '✓';
  if (status === 'failed' || status === 'denied') return '!';
  if (status === 'cancelled') return '■';
  if (status === 'running' || status === 'streaming') return '●';
  if (status === 'queued' || status === 'waiting' || status === 'pending') {
    return '◌';
  }
  return '○';
}

function rowDuration(row: ConversationRow): string {
  if (row.startedAt === undefined || row.completedAt === undefined) return '';
  const ms = Math.max(0, row.completedAt - row.startedAt);
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.floor((ms % 60_000) / 1_000)}s`;
}

function relativeTime(value: number | undefined): string {
  if (value === undefined) return '';
  return new Date(value).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function changedWorkspaceCount(
  projection: ProductProjection | undefined
): number {
  return (
    projection?.rows.filter(
      (row) =>
        row.kind === 'tool' &&
        row.status === 'completed' &&
        [
          'write_file',
          'append_file',
          'replace_in_file',
          'apply_patch',
          'apply_unified_diff',
          'delete_file',
        ].includes(row.toolName ?? '')
    ).length ?? 0
  );
}

function shortSession(sessionId: string | undefined): string {
  return sessionId ? sanitizeSingleLine(sessionId).slice(-12) : 'draft';
}

function marker(value: SessionListRow['marker']): string {
  if (value === 'current') return '●';
  if (value === 'running') return '◐';
  if (value === 'attention') return '!';
  return '○';
}

function statusMarkerStyle(
  value: SessionListRow['marker']
): { fg: ThemeToken; bold?: boolean } {
  if (value === 'current' || value === 'running') {
    return { fg: 'accent', bold: true };
  }
  if (value === 'attention') return { fg: 'warning', bold: true };
  return { fg: 'muted' };
}

function countPatch(review: TuiReviewSnapshot, prefix: string): number {
  return review.files.reduce(
    (count, file) =>
      count +
      (file.patch?.split('\n').filter((line) => line.startsWith(prefix))
        .length ?? 0),
    0
  );
}
