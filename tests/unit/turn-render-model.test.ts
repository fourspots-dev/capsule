import { describe, expect, it } from 'vitest';
import type {
  ChildTaskProjection,
  ConversationRow,
  ProductProjection,
} from '../../src/core/types';
import {
  buildTurnRenderUnits,
  toolFamily,
  workStateLabel,
} from '../../src/sidepanel/turn-render-model';

function projection(
  rows: ConversationRow[],
  overrides: Partial<ProductProjection> = {}
): ProductProjection {
  return {
    sessionId: 'session_1',
    revision: 1,
    eventSeq: 1,
    logEpoch: 'epoch',
    phase: 'completed',
    lifecycle: 'ready',
    taskStatus: 'completed',
    inputRouting: 'startNow',
    queueLength: 0,
    permissionMode: 'build',
    rows,
    availability: {
      canSend: true,
      canStop: false,
      canApprove: false,
      canQueue: false,
    },
    ...overrides,
  };
}

function row(
  id: string,
  kind: ConversationRow['kind'],
  text: string,
  overrides: Partial<ConversationRow> = {}
): ConversationRow {
  return {
    id,
    entityId: id,
    productTurnId: 'task_1',
    kind,
    text,
    status: 'completed',
    ...overrides,
  };
}

describe('turn render model', () => {
  it('separates the latest answer and groups consecutive tools by family', () => {
    const child: ChildTaskProjection = {
      taskId: 'child_1',
      sessionId: 'child_session',
      parentTaskId: 'task_1',
      profileName: 'general',
      status: 'completed',
      executionMode: 'foreground',
      summary: 'Child result',
    };
    const rows = [
      row('user_1', 'user', 'Inspect the page'),
      row('activity_1', 'activity', 'Thinking complete', {
        startedAt: 1_000,
        completedAt: 3_400,
      }),
      row('reason_1', 'reasoning', 'Read the page before answering.'),
      row('assistant_mid', 'assistant', 'I will inspect it.'),
      row('tool_1', 'tool', '{}', { toolName: 'navigate', callId: 'call_1' }),
      row('tool_2', 'tool', '{}', { toolName: 'click', callId: 'call_2' }),
      row('tool_3', 'tool', '{}', { toolName: 'read_page', callId: 'call_3' }),
      row('assistant_final', 'assistant', 'The page is ready.'),
    ];

    const [unit] = buildTurnRenderUnits(projection(rows, { children: [child] }));
    const [segment] = unit.segments;

    expect(segment.latestAssistant?.id).toBe('assistant_final');
    expect(segment.historyRows.map((item) => item.id)).toEqual([
      'activity_1',
      'reason_1',
      'assistant_mid',
      'tool_1',
      'tool_2',
      'tool_3',
    ]);
    expect(segment.workItems.map((item) => item.kind)).toEqual([
      'reasoning',
      'assistant',
      'tool-group',
      'tool',
      'child',
    ]);
    expect(segment.workItems[2].group?.family).toBe('browser');
    expect(segment.workItems[2].group?.rows.map((item) => item.id)).toEqual([
      'tool_1',
      'tool_2',
    ]);
    expect(segment.children).toEqual([child]);
    expect(segment.durationMs).toBe(2_400);
    expect(segment.defaultOpen).toBe(false);
    expect(workStateLabel(segment, 'en')).toBe('Worked for 2s');
  });

  it('keeps failed work open even when it has a final answer', () => {
    const rows = [
      row('user_1', 'user', 'Try it'),
      row('tool_1', 'tool', 'permission denied', {
        toolName: 'write_file',
        status: 'failed',
      }),
      row('assistant_1', 'assistant', 'The operation failed.'),
    ];

    const [segment] = buildTurnRenderUnits(
      projection(rows, { taskStatus: 'failed', phase: 'error' })
    )[0].segments;

    expect(segment.state).toBe('failed');
    expect(segment.defaultOpen).toBe(true);
    expect(workStateLabel(segment, 'zh')).toBe('失败');
  });

  it('keeps intermediate assistant text inside running work history', () => {
    const rows = [
      row('user_1', 'user', 'Inspect'),
      row('assistant_1', 'assistant', 'I will inspect it.'),
      row('tool_1', 'tool', '', {
        toolName: 'snapshot',
        status: 'pending',
      }),
    ];

    const [segment] = buildTurnRenderUnits(
      projection(rows, {
        taskStatus: 'running',
        phase: 'running',
        activeTaskId: 'task_1',
      })
    )[0].segments;

    expect(segment.latestAssistant).toBeUndefined();
    expect(segment.historyRows.map((item) => item.id)).toEqual([
      'assistant_1',
      'tool_1',
    ]);
    expect(segment.workItems.map((item) => item.kind)).toEqual([
      'assistant',
      'tool',
    ]);
  });

  it('turns guided inputs in one task into independent work segments', () => {
    const secondChild: ChildTaskProjection = {
      taskId: 'child_2',
      sessionId: 'child_session_2',
      parentTaskId: 'task_1',
      profileName: 'custom-profile',
      status: 'running',
      executionMode: 'background',
    };
    const rows = [
      row('user_1', 'user', 'First'),
      row('assistant_1', 'assistant', 'First answer'),
      row('user_2', 'user', 'Steer it'),
      row('tool_2', 'tool', 'running', {
        toolName: 'exec',
        status: 'pending',
      }),
      row('assistant_2', 'assistant', 'Second answer'),
    ];

    const [unit] = buildTurnRenderUnits(
      projection(rows, {
        taskStatus: 'running',
        phase: 'running',
        activeTaskId: 'task_1',
        children: [secondChild],
      })
    );

    expect(unit.segments).toHaveLength(2);
    expect(unit.segments.map((segment) => segment.user?.text)).toEqual([
      'First',
      'Steer it',
    ]);
    expect(unit.segments.map((segment) => segment.latestAssistant?.text)).toEqual([
      'First answer',
      'Second answer',
    ]);
    expect(unit.segments[0].children).toEqual([]);
    expect(unit.segments[1].children).toEqual([secondChild]);
    expect(unit.segments.every((segment) => segment.defaultOpen)).toBe(true);
  });

  it('does not project the active running state onto queued product turns', () => {
    const rows = [
      row('user_1', 'user', 'Active work', { productTurnId: 'task_1' }),
      row('user_2', 'user', 'Queued work', {
        productTurnId: 'task_2',
        status: 'pending',
      }),
    ];
    const units = buildTurnRenderUnits(
      projection(rows, {
        taskStatus: 'running',
        phase: 'running',
        activeTaskId: 'task_1',
        queueLength: 1,
      })
    );

    expect(units.map((unit) => unit.productTurnId)).toEqual(['task_1', 'task_2']);
    expect(units[0].segments[0].running).toBe(true);
    expect(units[1].segments[0].running).toBe(false);
    expect(units[1].segments[0].state).toBe('idle');
  });

  it('maps semantic tool families used by compact summaries', () => {
    expect(toolFamily('navigate')).toBe('browser');
    expect(toolFamily('read_page')).toBe('explore');
    expect(toolFamily('exec')).toBe('terminal');
    expect(toolFamily('apply_patch')).toBe('changes');
    expect(toolFamily('apply_unified_diff')).toBe('changes');
    expect(toolFamily('spawn_agent')).toBe('subagent');
    expect(toolFamily('screenshot')).toBe('artifact');
    expect(toolFamily('unknown_tool')).toBe('other');
  });
});
