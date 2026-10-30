import { describe, expect, it } from 'vitest';
import { PlanModeController, PolicyEngine } from '../../src/core/policy';
import { ToolExecutor } from '../../src/core/tool-executor';
import { FakeApproval, writeTool } from '../harness/fakes';

const read = {
  sessionId: 's',
  taskId: 't',
  callId: 'c',
  toolName: 'read',
  capabilities: ['browser:read'],
  effect: 'read' as const,
  risk: 'read' as const,
  input: {},
};
const write = {
  ...read,
  toolName: 'click',
  capabilities: ['browser:interact'],
  effect: 'write' as const,
  risk: 'write' as const,
};

describe('PolicyEngine', () => {
  it('blocks writes in plan mode while allowing reads', async () => {
    const engine = new PolicyEngine(() => 'plan');
    await expect(engine.evaluate(read)).resolves.toMatchObject({ decision: 'allow' });
    await expect(engine.evaluate(write)).resolves.toMatchObject({
      decision: 'deny',
      reason: expect.stringContaining('read-only'),
    });
  });

  it('asks for high-risk actions outside sandbox auto', async () => {
    const guarded = new PolicyEngine(() => 'guarded');
    await expect(guarded.evaluate(write)).resolves.toMatchObject({ decision: 'ask' });
    const sandbox = new PolicyEngine(() => 'sandbox-auto');
    await expect(sandbox.evaluate(write)).resolves.toMatchObject({ decision: 'allow' });
    await expect(
      sandbox.evaluate({ ...write, effect: 'network', toolName: 'network' })
    ).resolves.toMatchObject({ decision: 'ask' });
  });

  it('integrates with ToolExecutor so denied tools never execute', async () => {
    const tool = writeTool('click');
    tool.effect = 'write';
    tool.capabilities = ['browser:interact'];
    let effects = 0;
    tool.execute = async () => {
      effects += 1;
      return 'clicked';
    };
    const executor = new ToolExecutor([tool], new FakeApproval(true), {
      policy: new PolicyEngine(() => 'plan'),
    });
    const result = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: { id: 'c', name: 'click', arguments: '{}' },
    });
    expect(result).toMatchObject({
      status: 'denied',
      error: { code: 'TOOL_POLICY_DENIED' },
    });
    expect(effects).toBe(0);
  });
});

describe('PlanModeController', () => {
  it('requires an approved current plan before build mode', async () => {
    const controller = new PlanModeController(() => 10, 'plan');
    await expect(controller.submitPlan('1. inspect\n2. verify')).resolves.toMatchObject({
      mode: 'plan',
      plan: expect.stringContaining('inspect'),
    });
    expect(() => controller.setMode('build')).toThrowError(/must be approved/);
    const digest = controller.getState().approvedDigest;
    expect(controller.approvePlan(digest)).toMatchObject({ approvedAt: 10 });
    expect(controller.setMode('build')).toMatchObject({
      mode: 'build',
      approvedAt: 10,
    });
  });
});
