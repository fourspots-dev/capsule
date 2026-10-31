import { describe, expect, it } from 'vitest';
import type { ConversationRow, ProductProjection } from '../../src/core';
import {
  displayWidth,
  renderTui,
  renderTuiAnsi,
  renderTuiDocument,
  renderTuiFrame,
  type TuiRenderSnapshot,
} from '../../src/tui';

describe('rich TUI renderer', () => {
  it('renders semantic panels, live reasoning, tools and a wide context column', () => {
    const view = snapshot(projection());
    const screen = renderTui(view, 120, 30);
    const text = screen.join('\n');

    expect(screen).toHaveLength(30);
    expect(screen.every((line) => displayWidth(line) === 120)).toBe(true);
    expect(text).toContain('THINKING');
    expect(text).toContain('Inspect the merge base');
    expect(text).toContain('CONTEXT');
    expect(text).toContain('AGENTS');
    expect(text).toContain('schema-worker');
    expect(text).toContain('apply_patch');
    expect(text).toContain('RESULT');
    expect(text).not.toContain('Thinking complete');
    expect(text).not.toContain('\x1b');
  });

  it('emits truecolor spans while keeping a safe no-color mode', () => {
    const view = snapshot(projection());
    const colored = renderTuiAnsi(view, 100, 26, {
      theme: 'dark',
      depth: 'truecolor',
    }).join('\n');
    const plain = renderTuiAnsi(view, 100, 26, {
      theme: 'dark',
      depth: 'none',
    }).join('\n');

    expect(colored).toContain('38;2;187;154;247');
    expect(colored).toContain('\x1b[0m');
    expect(plain).not.toContain('\x1b');
    expect(plain).toContain('THINKING');
  });

  it('collapses completed reasoning in preview mode and expands it in full mode', () => {
    const completed = projection();
    const reasoning = completed.rows.find((row) => row.kind === 'reasoning')!;
    reasoning.status = 'completed';
    reasoning.completedAt = 1_100;
    const preview = renderTui(
      snapshot(completed, 'preview'),
      100,
      26
    ).join('\n');
    const full = renderTui(snapshot(completed, 'full'), 100, 26).join('\n');

    expect(preview).toContain('Thought ·');
    expect(preview).not.toContain('Inspect the merge base');
    expect(full).toContain('THOUGHT');
    expect(full).toContain('Inspect the merge base');
  });

  it('keeps the compact layout and sanitizes model-controlled escape sequences', () => {
    const projectionValue = projection();
    projectionValue.rows.at(-1)!.text =
      'safe\x1b[2J text\x1b]0;owned\x07\x1b]8;;https://evil.invalid\x07link\x1b]8;;\x07';
    const screen = renderTui(snapshot(projectionValue), 60, 20);
    const text = screen.join('\n');

    expect(screen.every((line) => displayWidth(line) <= 60)).toBe(true);
    expect(text).not.toContain('CONTEXT');
    expect(text).toContain('PROMPT');
    expect(text).toContain('safe textlink');
    expect(text).not.toContain('\x1b');
    expect(text).not.toContain('\x07');
  });

  it('formats markdown and diff rows as styled spans without changing their content', () => {
    const view = snapshot(projection());
    const document = renderTuiDocument(view, 100, 30);
    const spans = document.flatMap((line) => line.spans);
    expect(
      spans.some(
        (span) => span.style.fg === 'reasoning' || span.style.fg === 'tool'
      )
    ).toBe(true);
    expect(
      spans.some(
        (span) => span.style.fg === 'success' || span.style.fg === 'added'
      )
    ).toBe(true);
    expect(document.map((line) => line.spans.map((span) => span.text).join('')).join('\n'))
      .toContain('+added');
  });

  it('uses a stable gutter hierarchy for user, work items and final result', () => {
    const screen = renderTui(snapshot(projection()), 100, 30);
    const userBody = screen.find((line) =>
      line.includes('Implement three-way merge')
    )!;
    const reasoningPanel = screen.find((line) => line.includes('THINKING'))!;
    const tool = screen.find((line) => line.includes('apply_patch'))!;
    const result = screen.find((line) => line.includes('RESULT'))!;

    expect(userBody.startsWith('  ')).toBe(true);
    expect(reasoningPanel.startsWith('  ╭─')).toBe(true);
    expect(tool.startsWith('    ✓')).toBe(true);
    expect(result.startsWith('◆ RESULT')).toBe(true);
  });

  it('returns an absolute native cursor target for the composer', () => {
    const view = snapshot(projection());
    const frame = renderTuiFrame(view, 80, 24, {
      theme: 'dark',
      depth: 'none',
    });
    const composerLine = frame.lines[frame.cursor.row - 1];

    expect(frame.cursor.visible).toBe(true);
    expect(frame.cursor.shape).toBe('block');
    expect(composerLine).toContain('> continue the implementation');
    expect(composerLine).not.toContain('▌');
    expect(frame.cursor.column).toBeGreaterThan(4);
    expect(frame.cursor.column).toBeLessThanOrEqual(79);
  });

  it('locates the native cursor after wide characters and explicit newlines', () => {
    const view = snapshot(projection());
    view.composer = '第一行\nsecond中';
    view.composerCursor = view.composer.length;
    const frame = renderTuiFrame(view, 60, 24, {
      theme: 'dark',
      depth: 'none',
    });
    const composerLine = frame.lines[frame.cursor.row - 1];

    expect(composerLine).toContain('second中');
    expect(frame.cursor.column).toBe(3 + displayWidth('second中'));
  });

  it('keeps the native cursor aligned at the context-panel height boundary', () => {
    const view = snapshot(projection());
    view.composer = 'border test';
    view.composerCursor = view.composer.length;
    const frame = renderTuiFrame(view, 108, 20, {
      theme: 'dark',
      depth: 'none',
    });

    expect(frame.lines[frame.cursor.row - 1]).toContain('> border test');
    expect(frame.lines[frame.cursor.row - 1]).not.toContain('CONTEXT');
  });

  it('does not label intermediate messages as RESULT while their turn is active', () => {
    const active = projection();
    active.taskStatus = 'running';
    active.activeTaskId = 'task_1';
    const text = renderTui(snapshot(active), 100, 30).join('\n');

    expect(text).toContain('· TINYAI');
    expect(text).not.toContain('◆ RESULT');
  });

  it('bounds very large streamed messages while preserving the latest tail', () => {
    const view = projection();
    const final = view.rows.find((row) => row.kind === 'assistant')!;
    final.text = `${'head '.repeat(20_000)}LATEST-TAIL`;
    const text = renderTui(snapshot(view), 100, 24).join('\n');

    expect(text).toContain('chars clipped');
    expect(text).toContain('LATEST-TAIL');
  });
});

function snapshot(
  projectionValue: ProductProjection,
  reasoningMode: 'hidden' | 'preview' | 'full' = 'preview'
): TuiRenderSnapshot {
  return {
    route: { kind: 'conversation' },
    status: {
      connection: 'online',
      taskStatus: projectionValue.taskStatus,
      sessionTitle: 'merge-driver',
      project: 'mini-git',
      branch: 'feature/merge',
      dirty: true,
      model: 'deepseek-chat',
      provider: 'host-fs',
      agentCount: 2,
    },
    activeSessionId: projectionValue.sessionId,
    activeSessionTitle: 'merge-driver',
    projection: projectionValue,
    sessions: [],
    sessionQuery: '',
    agentRows: [],
    agentFilter: 'all',
    composer: 'continue the implementation',
    composerCursor: 12,
    reasoningMode,
  };
}

function projection(): ProductProjection {
  return {
    sessionId: 'session_rich',
    revision: 12,
    eventSeq: 32,
    logEpoch: 'epoch_rich',
    phase: 'running',
    lifecycle: 'ready',
    taskStatus: 'running',
    inputRouting: 'startNow',
    queueLength: 1,
    permissionMode: 'sandbox-auto',
    rows: [
      row('user_1', 'user', 'Implement three-way merge with conflict markers.'),
      row(
        'reasoning_1',
        'reasoning',
        'Inspect the merge base and compare ours with theirs.\n\n```ts\nconst base = read(baseId);\n```',
        'streaming',
        'message_1'
      ),
      row(
        'tool_1',
        'tool',
        JSON.stringify({
          exitCode: 0,
          stdout: 'merge.ts: 3 conflicts resolved',
          stderr: '',
        }),
        'completed',
        'task_1',
        'apply_patch'
      ),
      row(
        'activity_1',
        'activity',
        'Thinking complete',
        'completed',
        'task_1'
      ),
      row(
        'answer_1',
        'assistant',
        '## RESULT\n\n- merge driver implemented\n\n```diff\n+added\n-removed\n```',
        'completed'
      ),
    ],
    children: [
      {
        taskId: 'child_1',
        sessionId: 'child_session',
        parentTaskId: 'task_1',
        profileName: 'schema-worker',
        status: 'running',
        executionMode: 'background',
        summary: 'testing merge cases',
      },
    ],
    availability: {
      canSend: true,
      canStop: true,
      canApprove: false,
      canQueue: true,
    },
  };
}

function row(
  id: string,
  kind: ConversationRow['kind'],
  text: string,
  status: ConversationRow['status'] = 'completed',
  productTurnId = 'task_1',
  toolName?: string
): ConversationRow {
  return {
    id,
    entityId: id,
    productTurnId,
    kind,
    text,
    status,
    startedAt: 1_000,
    ...(status === 'completed' ? { completedAt: 1_100 } : {}),
    ...(toolName ? { toolName } : {}),
  };
}
