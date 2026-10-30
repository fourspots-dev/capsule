import { describe, expect, it, vi } from 'vitest';
import { createSubagentTools } from '../../src/adapters/subagent-tools';
import type { ChildResult } from '../../src/core';
import { ToolExecutor } from '../../src/core';
import { FakeApproval } from '../harness/fakes';

function coordinator() {
  return {
    spawn: vi.fn(async (spec) => ({
      taskId: 'child_1',
      sessionId: 'child_session',
      ...spec,
      status: spec.executionMode === 'foreground' ? 'completed' : 'running',
      result:
        spec.executionMode === 'foreground'
          ? { status: 'completed', summary: 'done', artifacts: [], unresolved: [] }
          : undefined,
    })),
    send: vi.fn(async () => undefined),
    wait: vi.fn(async (): Promise<ChildResult> => ({
      status: 'completed',
      summary: 'done',
      artifacts: [],
      unresolved: [],
    })),
    stop: vi.fn(async () => undefined),
    list: vi.fn(() => []),
  };
}

describe('subagent tools', () => {
  it('spawns arbitrary profiles and maps foreground/background semantics', async () => {
    const fake = coordinator();
    const executor = new ToolExecutor(
      createSubagentTools({
        coordinator: fake as any,
        parent: (invocation) => ({
          taskId: invocation.taskId,
          depth: 0,
          maxDepth: 2,
          permissions: {
            capabilities: ['browser:read', 'agent:spawn'],
            effects: ['read', 'write'],
          },
        }),
      }),
      new FakeApproval(true)
    );
    const result = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: {
        id: 'call_spawn',
        name: 'spawn_agent',
        arguments:
          '{"profile":"page-auditor","brief":"inspect","contextMode":"fresh","executionMode":"foreground"}',
      },
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      output: { status: 'completed', result: { summary: 'done' } },
    });
    expect(fake.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        parentTaskId: 'task_1',
        profile: 'page-auditor',
        contextMode: 'fresh',
      }),
      expect.objectContaining({ permissions: expect.any(Object) })
    );
  });

  it('passes send requests to the coordinator and exposes list/wait/stop', async () => {
    const fake = coordinator();
    const executor = new ToolExecutor(
      createSubagentTools({
        coordinator: fake as any,
        parent: () => ({
          taskId: 'parent_1',
          depth: 0,
          maxDepth: 2,
          permissions: { capabilities: [], effects: [] },
        }),
      }),
      new FakeApproval(true)
    );
    const send = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'c',
        name: 'send_message',
        arguments: '{"childTaskId":"child_1","message":"continue","delivery":"guide"}',
      },
    });
    expect(send.status).toBe('succeeded');
    expect(fake.send).toHaveBeenCalledWith('child_1', 'continue', 'guide');
  });
});
