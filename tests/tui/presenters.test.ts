import { describe, expect, it } from 'vitest';
import {
  buildAgentRows,
  buildSessionRows,
  displayWidth,
  presentStatusBar,
  RouteController,
  sanitizeSingleLine,
  selectAgent,
  type RuntimeSessionSummary,
  type TuiAgentRecord,
} from '../../src/tui';
import { globToRegExp } from '../../src/virtual';

describe('TUI status bar', () => {
  it('keeps blockers and task state while dropping lower-priority cells', () => {
    const presentation = presentStatusBar(
      {
        blockers: ['APPROVAL'],
        connection: 'online',
        taskStatus: 'running',
        elapsedMs: 134_000,
        sessionTitle: 'fix-auth',
        project: 'tinyai',
        branch: 'main',
        dirty: true,
        queueLength: 2,
        agentCount: 3,
        agentAttention: 1,
        model: 'deepseek-chat',
        provider: 'local',
        extensionCells: Array.from({ length: 10 }, (_, index) => ({
          key: `ext_${index}`,
          text: `extension-${index}`,
          priority: index,
        })),
      },
      80
    );
    expect(presentation.text).toContain('APPROVAL');
    expect(presentation.text).toContain('RUN 02:14');
    expect(displayWidth(presentation.text)).toBeLessThanOrEqual(80);
    expect(
      presentation.segments.filter((item) => item.key.startsWith('extension:')).length
    ).toBeLessThanOrEqual(2);
    expect(presentation.text).toContain('ext 10');
  });

  it('sanitizes terminal control sequences and handles wide/combining text', () => {
    expect(sanitizeSingleLine('ok\x1b[2J bad')).toBe('ok bad');
    expect(displayWidth('中文')).toBe(4);
    expect(displayWidth('e\u0301')).toBe(1);
    const status = presentStatusBar(
      {
        blockers: ['ERR \u001b[31mred'],
        connection: 'offline',
        taskStatus: 'failed',
        sessionTitle: '很长的会话标题',
      },
      40
    );
    expect(status.text).not.toContain('\u001b');
    expect(status.text).toContain('OFFLINE');
    expect(displayWidth(status.text)).toBeLessThanOrEqual(40);
  });
});

describe('TUI route, session list and agent board', () => {
  it('maintains a bounded, reversible route stack', () => {
    const routes = new RouteController();
    routes.push({ kind: 'sessions', query: '' });
    routes.push({ kind: 'agents', rootSessionId: 's1' });
    expect(routes.back()).toEqual({ kind: 'sessions', query: '' });
    expect(routes.back()).toEqual({ kind: 'conversation' });
    expect(routes.back()).toEqual({ kind: 'conversation' });
  });

  it('filters sessions by project, branch and status while keeping current visible', () => {
    const sessions: RuntimeSessionSummary[] = [
      summary('a', 'fix auth', 'tinyai', 'main', 'running'),
      summary('b', 'docs', 'site', 'docs', 'completed'),
      summary('c', 'ui', 'tinyai', 'ui', 'failed', 1),
    ];
    expect(buildSessionRows(sessions, 'tinyai failed', 'c')).toEqual([
      expect.objectContaining({
        sessionId: 'c',
        marker: 'current',
        title: 'ui',
      }),
    ]);
    expect(buildSessionRows(sessions, 'main', 'b').map((row) => row.sessionId))
      .toEqual(['a']);
  });

  it('renders arbitrary profiles and preserves ancestor paths under filters', () => {
    const agents: TuiAgentRecord[] = [
      agent('root', 'root', 'orchestrator', 'running'),
      agent('a', 'root', 'schema-migration', 'running'),
      agent('b', 'a', 'fixture-generator', 'completed'),
      agent('c', 'root', 'release-auditor', 'failed'),
    ];
    expect(buildAgentRows(agents, 's', 'all')).toHaveLength(4);
    expect(buildAgentRows(agents, 's', 'attention').map((row) => row.agent.taskId))
      .toEqual(['root', 'c']);
    expect(buildAgentRows(agents, 's', 'done').map((row) => row.agent.taskId))
      .toEqual(['root', 'a', 'b']);
    const rows = buildAgentRows(agents, 's', 'all');
    expect(selectAgent(rows, 'a', 1)).toBe('b');
    expect(selectAgent(rows, undefined, -1)).toBe('c');
  });
});

function summary(
  sessionId: string,
  title: string,
  project: string,
  branch: string,
  taskStatus: RuntimeSessionSummary['taskStatus'],
  attentionCount = 0
): RuntimeSessionSummary {
  return {
    sessionId,
    title,
    project,
    branch,
    taskStatus,
    lifecycle: 'ready',
    revision: 1,
    eventSeq: 1,
    updatedAt: sessionId.charCodeAt(0),
    queueLength: 0,
    childCount: attentionCount,
    attentionCount,
  };
}

function agent(
  taskId: string,
  parentTaskId: string,
  profileName: string,
  status: TuiAgentRecord['status']
): TuiAgentRecord {
  return {
    taskId,
    sessionId: `session_${taskId}`,
    parentTaskId,
    parentSessionId: 's',
    profileName,
    status,
    executionMode: 'background',
    createdAt: taskId.charCodeAt(0),
  };
}
