import { describe, expect, it, vi } from 'vitest';
import {
  HookRunner,
  hookDigest,
  type HookDefinition,
} from '../../src/core/hooks';
import { ToolExecutor } from '../../src/core/tool-executor';
import { FakeApproval, readTool } from '../harness/fakes';

async function register(
  runner: HookRunner,
  definition: HookDefinition,
  content = definition.name
): Promise<void> {
  await runner.register({
    definition,
    source: 'builtin',
    content,
    expectedDigest: await hookDigest(content),
  });
}

describe('HookRunner', () => {
  it('applies modifyInput in order and lets a later hard deny win', async () => {
    const runner = new HookRunner();
    await register(runner, {
      name: 'rewrite',
      event: 'PreToolUse',
      toolNames: ['click'],
      run: ({ input }) => ({
        decision: 'modifyInput',
        input: { ...(input as object), selector: 'button.safe' },
      }),
    });
    await register(runner, {
      name: 'deny-finance',
      event: 'PreToolUse',
      run: () => ({ decision: 'deny', reason: 'finance site is blocked' }),
    });
    await register(runner, {
      name: 'try-allow',
      event: 'PreToolUse',
      run: () => ({ decision: 'allow' }),
    });
    const decision = await runner.before(
      {
        sessionId: 's',
        taskId: 't',
        callId: 'c',
        toolName: 'click',
        input: { selector: 'button.pay' },
      },
      new AbortController().signal
    );
    expect(decision).toEqual({
      decision: 'deny',
      input: { selector: 'button.safe' },
      reason: 'finance site is blocked',
    });
  });

  it('keeps post hook context separate from the tool result and isolates failures', async () => {
    const runner = new HookRunner();
    await register(runner, {
      name: 'context',
      event: 'PostToolUse',
      run: () => ({ decision: 'context', content: 'policy note' }),
    });
    await register(runner, {
      name: 'broken',
      event: 'PostToolUse',
      run: () => {
        throw new Error('post failed');
      },
    });
    const result = { callId: 'c', name: 'read', status: 'succeeded' as const, output: 'data' };
    const records = await runner.after(
      {
        sessionId: 's',
        taskId: 't',
        callId: 'c',
        toolName: 'read',
        input: {},
      },
      result,
      new AbortController().signal
    );
    expect(result.output).toBe('data');
    expect(records.find((record) => record.hookName === 'context')?.contexts).toEqual([
      'policy note',
    ]);
    expect(records.find((record) => record.hookName === 'broken')?.errors[0]).toMatchObject({
      code: 'HOOK_POST_FAILED',
    });
  });

  it('rejects digest drift and untrusted external hooks', async () => {
    const runner = new HookRunner();
    const definition: HookDefinition = {
      name: 'user-hook',
      event: 'PreToolUse',
      run: () => ({ decision: 'allow' }),
    };
    await expect(
      runner.register({
        definition,
        source: 'user',
        content: 'one',
        expectedDigest: '0'.repeat(64),
      })
    ).rejects.toMatchObject({ code: 'HOOK_DIGEST_MISMATCH' });
    await expect(
      runner.register({
        definition,
        source: 'user',
        content: 'two',
        expectedDigest: await hookDigest('two'),
      })
    ).rejects.toMatchObject({ code: 'HOOK_UNTRUSTED' });
  });

  it('fails closed when a pre hook itself fails', async () => {
    const runner = new HookRunner();
    const run = vi.fn(() => {
      throw new Error('boom');
    });
    await register(runner, { name: 'broken', event: 'PreToolUse', run });
    await expect(
      runner.before(
        {
          sessionId: 's',
          taskId: 't',
          callId: 'c',
          toolName: 'read',
          input: {},
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ decision: 'deny' });
  });

  it('runs hooks inside ToolExecutor without changing the model-visible result contract', async () => {
    const runner = new HookRunner();
    await register(runner, {
      name: 'rewrite',
      event: 'PreToolUse',
      run: () => ({ decision: 'modifyInput', input: { text: 'rewritten' } }),
    });
    await register(runner, {
      name: 'note',
      event: 'PostToolUse',
      run: () => ({ decision: 'context', content: 'separate context' }),
    });
    const postRecords: unknown[] = [];
    const executor = new ToolExecutor(
      [readTool('read', async (input) => JSON.stringify(input))],
      new FakeApproval(false),
      {
        hooks: runner,
        onPostToolUse: (records) => postRecords.push(...records),
      }
    );
    const result = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: { id: 'c', name: 'read', arguments: '{"text":"original"}' },
    });
    expect(result).toEqual({
      callId: 'c',
      name: 'read',
      status: 'succeeded',
      output: '{"text":"rewritten"}',
    });
    expect(postRecords).toHaveLength(1);
  });
});
