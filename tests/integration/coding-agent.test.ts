import { describe, expect, it } from 'vitest';
import {
  InMemorySandbox,
  PermissionModeRegistry,
  PolicyEngine,
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
} from '../../src/core';
import { createSandboxTools } from '../../src/adapters/sandbox-tools';
import { FakeApproval, FakeClock, FakeModelTransport, events, text, toolCall } from '../harness/fakes';
import { command } from '../harness/workspace';

describe('sandbox coding vertical slice', () => {
  it('writes code and verifies it without leaving the leased workspace', async () => {
    const sandbox = new InMemorySandbox({
      now: () => 10,
      exec: async (request) => {
        if (request.command !== 'npm' || request.args?.join(' ') !== 'test') {
          return {
            exitCode: 127,
            stdout: '',
            stderr: 'command not found',
            durationMs: 1,
            stdoutTruncated: false,
            stderrTruncated: false,
          };
        }
        return {
          exitCode: 0,
          stdout: '1 test passed',
          stderr: '',
          durationMs: 12,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    });
    const lease = await sandbox.createWorkspace({ sessionId: 'coding_session' });
    const modes = new PermissionModeRegistry('sandbox-auto', () => 10);
    const tools = new ToolExecutor(createSandboxTools(sandbox, lease), new FakeApproval(true), {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
    });
    const model = new FakeModelTransport(async (_request, index) => {
      if (index === 0) {
        return events(...toolCall('write_1', 'write_file', {
          path: 'src/value.ts',
          text: 'export const value = 42;\n',
        }));
      }
      if (index === 1) {
        return events(...toolCall('test_1', 'run_tests', {
          command: 'npm',
          args: ['test'],
        }));
      }
      return events(...text('Implemented value and verified it.'));
    });
    const runtime = new WorkspaceRuntime({
      model,
      tools,
      clock: new FakeClock(),
      ids: new SequentialIdGenerator(),
      permissionModes: modes,
    });

    const ack = await runtime.command(command('coding_session', 'command_1', 'implement value'));
    expect(ack.status).toBe('accepted');
    await runtime.waitForSessionIdle('coding_session');

    expect(
      new TextDecoder().decode((await sandbox.readFile(lease, 'src/value.ts')).data)
    ).toBe('export const value = 42;\n');
    expect(runtime.getProjection('coding_session')).toMatchObject({
      taskStatus: 'completed',
      permissionMode: 'sandbox-auto',
    });
    expect(
      runtime
        .getProjection('coding_session')
        .rows.filter((row) => row.kind === 'tool')
        .map((row) => row.toolName)
    ).toEqual(['write_file', 'run_tests']);
    expect(model.requests.at(-1)?.messages.at(-1)).toMatchObject({
      role: 'tool',
      name: 'run_tests',
      content: expect.stringContaining('"passed":true'),
    });
  });
});
