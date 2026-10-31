import { sanitizeSingleLine, truncateDisplay, displayWidth } from './text';
import type { StatusBarFacts, StatusExtension } from './types';

interface Segment {
  priority: number;
  key: string;
  text: string;
  required?: boolean;
}

export interface StatusBarPresentation {
  text: string;
  segments: Segment[];
  hidden: Segment[];
}

export function presentStatusBar(
  facts: StatusBarFacts,
  width: number
): StatusBarPresentation {
  const segments = statusSegments(facts).map((segment) => ({
    ...segment,
    text: sanitizeSingleLine(segment.text),
  }));
  const required = segments.filter((segment) => segment.required);
  const optional = segments.filter((segment) => !segment.required);
  const selected = [...required];
  const hidden: Segment[] = [];

  for (const segment of optional) {
    if (fits([...selected, segment], width)) selected.push(segment);
    else hidden.push(segment);
  }
  selected.sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key));
  if (!fits(selected, width)) {
    const compact = fitRequired(selected, width);
    return {
      text: compact,
      segments: selected,
      hidden: [...hidden, ...selected.filter((segment) => !compact.includes(segment.text))],
    };
  }
  return {
    text: joinSegments(selected),
    segments: selected,
    hidden,
  };
}

function statusSegments(facts: StatusBarFacts): Segment[] {
  const blockers = [...(facts.blockers ?? [])];
  if (facts.connection === 'offline') blockers.push('OFFLINE');
  if (facts.connection === 'reconnecting') blockers.push('RECONNECT');
  const status = taskLabel(facts);
  const session = facts.sessionTitle
    ? `${facts.sessionKind === 'child' ? 'child · ' : ''}${facts.sessionTitle}`
    : undefined;
  const workspace = [facts.project, facts.branch]
    .filter(Boolean)
    .join(' ');
  const activity = [
    facts.queueLength ? `queue ${facts.queueLength}` : undefined,
    facts.agentCount
      ? `agents ${facts.agentCount}${facts.agentAttention ? ` (${facts.agentAttention}!)` : ''}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const environment = [
    facts.model,
    facts.provider,
    facts.processAvailable ? 'proc ✓' : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  const extensionCount = (facts.extensionCells ?? []).length;
  return [
    ...(blockers.length
      ? [
          {
            priority: 0,
            key: 'blockers',
            text: [...new Set(blockers)].join(' '),
            required: true,
          },
        ]
      : []),
    ...(status
      ? [{ priority: 1, key: 'task', text: status, required: true }]
      : []),
    ...(session
      ? [{ priority: 2, key: 'session', text: session, required: true }]
      : []),
    ...(workspace
      ? [
          {
            priority: 3,
            key: 'workspace',
            text: `${workspace}${facts.dirty ? '*' : ''}${
              facts.workspaceRevision ? ` rev ${facts.workspaceRevision}` : ''
            }`,
          },
        ]
      : []),
    ...(activity
      ? [{ priority: 4, key: 'activity', text: activity }]
      : []),
    ...(environment
      ? [{ priority: 5, key: 'environment', text: environment }]
      : []),
    ...extensionStatuses(facts.extensionCells ?? [], extensionCount),
  ];
}

function extensionStatuses(
  cells: readonly StatusExtension[],
  count: number
): Segment[] {
  if (!count) return [];
  const visible = [...cells]
    .sort((left, right) => left.priority - right.priority || left.key.localeCompare(right.key))
    .slice(0, 2)
    .map((cell) => ({
      priority: 6,
      key: `extension:${cell.key}`,
      text: cell.text,
    }));
  return [
    ...visible,
    ...(count > visible.length
      ? [{ priority: 6, key: 'extensions', text: `ext ${count}` }]
      : []),
  ];
}

function taskLabel(facts: StatusBarFacts): string | undefined {
  if (facts.taskLabel) {
    return facts.elapsedMs === undefined
      ? facts.taskLabel
      : `${facts.taskLabel} ${formatElapsed(facts.elapsedMs)}`;
  }
  if (!facts.taskStatus) return undefined;
  if (facts.taskStatus === 'running') {
    return facts.elapsedMs === undefined ? 'RUN' : `RUN ${formatElapsed(facts.elapsedMs)}`;
  }
  return {
    queued: 'QUEUED',
    waiting: 'WAIT',
    paused: 'PAUSED',
    completed: 'DONE',
    failed: 'FAILED',
    cancelled: 'CANCELLED',
  }[facts.taskStatus];
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  return `${String(Math.floor(totalSeconds / 60)).padStart(2, '0')}:${String(
    totalSeconds % 60
  ).padStart(2, '0')}`;
}

function fits(segments: readonly Segment[], width: number): boolean {
  return displayWidth(joinSegments(segments)) <= width;
}

function joinSegments(segments: readonly Segment[]): string {
  return segments.map((segment) => segment.text).filter(Boolean).join(' · ');
}

function fitRequired(segments: readonly Segment[], width: number): string {
  const required = segments
    .filter((segment) => segment.required)
    .map((segment) => segment.text);
  if (!required.length) return '';
  return truncateDisplay(required.join(' · '), width);
}
