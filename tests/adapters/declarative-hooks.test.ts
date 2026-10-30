import { describe, expect, it } from 'vitest';
import { registerDeclarativeHooks } from '../../src/adapters/declarative-hooks';
import { HookRunner } from '../../src/core/hooks';

describe('declarative hooks', () => {
  it('registers trusted serializable rules and enforces tool matchers', async () => {
    const runner = new HookRunner();
    expect(
      await registerDeclarativeHooks(runner, [
        {
          name: 'deny-payments',
          event: 'PreToolUse',
          source: 'project',
          trusted: true,
          toolNames: ['click'],
          decision: 'deny',
          reason: 'payments blocked',
        },
        {
          name: 'untrusted',
          event: 'PreToolUse',
          source: 'plugin',
          decision: 'allow',
        },
      ])
    ).toBe(1);
    await expect(
      runner.before(
        {
          sessionId: 's',
          taskId: 't',
          callId: 'c',
          toolName: 'click',
          input: {},
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ decision: 'deny', reason: 'payments blocked' });
    await expect(
      runner.before(
        {
          sessionId: 's',
          taskId: 't',
          callId: 'c2',
          toolName: 'read',
          input: {},
        },
        new AbortController().signal
      )
    ).resolves.toMatchObject({ decision: 'allow' });
  });
});
