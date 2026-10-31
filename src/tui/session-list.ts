import type { RuntimeSessionSummary } from './types';

export interface SessionListRow {
  sessionId: string;
  marker: 'current' | 'running' | 'attention' | 'idle';
  title: string;
  project: string;
  status: string;
  activity: string;
}

export function filterSessions(
  sessions: readonly RuntimeSessionSummary[],
  query: string,
  currentSessionId?: string
): RuntimeSessionSummary[] {
  const terms = query
    .trim()
    .toLocaleLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  return sessions
    .filter((session) => {
      if (!terms.length) return true;
      const text = [
        session.title,
        session.project,
        session.branch,
        session.taskStatus,
        session.parentSessionId,
      ]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase();
      return terms.every((term) => text.includes(term));
    })
    .sort((left, right) => {
      if (left.sessionId === currentSessionId) return -1;
      if (right.sessionId === currentSessionId) return 1;
      return right.updatedAt - left.updatedAt || left.sessionId.localeCompare(right.sessionId);
    });
}

export function buildSessionRows(
  sessions: readonly RuntimeSessionSummary[],
  query: string,
  currentSessionId?: string
): SessionListRow[] {
  return filterSessions(sessions, query, currentSessionId).map((session) => ({
    sessionId: session.sessionId,
    marker:
      session.sessionId === currentSessionId
        ? 'current'
        : session.attentionCount
          ? 'attention'
          : session.taskStatus === 'running' || session.taskStatus === 'queued'
            ? 'running'
            : 'idle',
    title: session.title,
    project: [session.project, session.branch].filter(Boolean).join('/') || '-',
    status:
      session.taskStatus === 'completed'
        ? 'DONE'
        : session.taskStatus.toUpperCase(),
    activity: [
      session.queueLength ? `${session.queueLength} queue` : undefined,
      session.childCount ? `${session.childCount} agent` : undefined,
      session.attentionCount ? `${session.attentionCount}!` : undefined,
      session.revision !== undefined ? `rev ${session.revision}` : undefined,
    ]
      .filter(Boolean)
      .join(' · '),
  }));
}
