import { describe, expect, it } from 'vitest';
import { createSandboxTools } from '../../src/adapters/sandbox-tools';
import { InMemorySandbox, ToolExecutor } from '../../src/core';
import { FakeApproval } from '../harness/fakes';

describe('sandbox tool adapter', () => {
  it('reads, writes and runs commands through the generic tool executor', async () => {
    const provider = new InMemorySandbox({
      now: () => 10,
      exec: async () => ({
        exitCode: 0,
        stdout: 'tests passed',
        stderr: '',
        durationMs: 5,
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    });
    const lease = await provider.createWorkspace({ sessionId: 'session_1' });
    const executor = new ToolExecutor(createSandboxTools(provider, lease), new FakeApproval(true));

    const write = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: {
        id: 'call_write',
        name: 'write_file',
        arguments: '{"path":"src/a.ts","text":"export const a = 1;"}',
      },
    });
    expect(write.status).toBe('succeeded');
    const read = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: {
        id: 'call_read',
        name: 'read_file',
        arguments: '{"path":"src/a.ts"}',
      },
    });
    expect(read.output).toMatchObject({ text: 'export const a = 1;' });
    const test = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: {
        id: 'call_test',
        name: 'run_tests',
        arguments: '{"command":"npm","args":["test"]}',
      },
    });
    expect(test.output).toMatchObject({ passed: true, exitCode: 0, stdout: 'tests passed' });
  });

  it('exposes sandbox capabilities and workspace effects', async () => {
    const provider = new InMemorySandbox();
    const lease = await provider.createWorkspace({ sessionId: 'session_1' });
    const tools = createSandboxTools(provider, lease);
    expect(tools.find((tool) => tool.name === 'read_file')).toMatchObject({
      effect: 'read',
      executionMode: 'parallel',
    });
    expect(tools.find((tool) => tool.name === 'write_file')).toMatchObject({
      effect: 'write',
      risk: 'write',
      executionMode: 'sequential',
    });
    expect(tools.find((tool) => tool.name === 'exec')).toMatchObject({
      effect: 'execute',
      risk: 'dangerous',
    });
    expect(tools.find((tool) => tool.name === 'terminal_open')).toBeDefined();
  });

  it('drives a persistent PTY through terminal tools', async () => {
    const provider = new InMemorySandbox();
    const lease = await provider.createWorkspace({ sessionId: 'session_1' });
    const executor = new ToolExecutor(createSandboxTools(provider, lease), new FakeApproval(true));
    const opened = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'open',
        name: 'terminal_open',
        arguments: '{"command":"sh"}',
      },
    });
    expect(opened.status).toBe('succeeded');
    const ptyId = (opened.output as any).ptyId as string;
    await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'write',
        name: 'terminal_write',
        arguments: JSON.stringify({ ptyId, data: 'echo hello\n' }),
      },
    });
    const read = await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'read',
        name: 'terminal_read',
        arguments: JSON.stringify({ ptyId }),
      },
    });
    expect(read.output).toEqual([
      { type: 'data', stream: 'stdout', data: 'echo hello\r\n' },
    ]);
    await executor.execute({
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
      call: {
        id: 'close',
        name: 'terminal_close',
        arguments: JSON.stringify({ ptyId }),
      },
    });
  });
});
