import { describe, expect, it } from 'vitest';
import { TaskGraph } from '../../src/core/task-graph';

describe('TaskGraph', () => {
  it('tracks parent-child cancellation and checkpointed terminal state', () => {
    const graph = new TaskGraph(() => 10);
    graph.create({ taskId: 'parent', sessionId: 's' });
    graph.create({ taskId: 'child', sessionId: 'child_s', parentTaskId: 'parent' });
    graph.create({ taskId: 'grandchild', sessionId: 'grand_s', parentTaskId: 'child' });
    expect(graph.cancelTree('parent', 'user_cancelled')).toEqual([
      'grandchild',
      'child',
      'parent',
    ]);
    expect(graph.list().every((task) => task.status === 'cancelled')).toBe(true);
    expect(graph.get('child')?.checkpoint).toEqual({ reason: 'user_cancelled' });
    expect(() => graph.transition('child', 'running')).toThrowError(/Invalid task transition/);
  });

  it('uses fencing tokens to reject stale writers', () => {
    let now = 10;
    const graph = new TaskGraph(() => now);
    graph.create({ taskId: 'task', sessionId: 's' });
    const lease = graph.claimLease('task', 'owner-a', 100);
    expect(() => graph.claimLease('task', 'owner-b', 100)).toThrowError(/lease is held/);
    graph.assertWrite('task', lease.fencingToken);
    now = 200;
    expect(() => graph.renewLease('task', lease.fencingToken, 100)).toThrowError(
      /lease expired/
    );
    const renewed = graph.claimLease('task', 'owner-b', 100);
    expect(() => graph.assertWrite('task', lease.fencingToken)).toThrowError(/Stale task lease/);
    graph.assertWrite('task', renewed.fencingToken);
  });

  it('pauses tasks when turn/tool/token budgets are exhausted', () => {
    const graph = new TaskGraph(() => 10);
    graph.create({
      taskId: 'task',
      sessionId: 's',
      budget: { maxTurns: 2, maxToolCalls: 5, maxTokens: 1000 },
    });
    graph.transition('task', 'running');
    graph.recordUsage('task', { turns: 1, toolCalls: 2, tokens: 200 });
    expect(graph.get('task')?.status).toBe('running');
    graph.recordUsage('task', { turns: 1 });
    expect(graph.get('task')?.status).toBe('paused');
  });

  it('rejects duplicate and orphan task ids', () => {
    const graph = new TaskGraph();
    graph.create({ taskId: 'a', sessionId: 's' });
    expect(() => graph.create({ taskId: 'a', sessionId: 's' })).toThrowError(/already exists/);
    expect(() =>
      graph.create({ taskId: 'b', sessionId: 's', parentTaskId: 'missing' })
    ).toThrowError(/Parent task not found/);
  });
});
