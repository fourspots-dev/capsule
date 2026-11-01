import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalActionExecutor } from '../../src/node/actions/local-action-executor';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('REQ-ACTION-001 local Action executor', () => {
  it('runs one allowlisted executable with argv and a fenced environment', async () => {
    const root = await workspace();
    process.env.TINYAI_ACTION_SECRET = 'must-not-leak';
    const executor = new LocalActionExecutor({
      workspaceRoot: root,
      executableAllowlist: ['node'],
    });
    const result = await executor.execute({
      executable: 'node',
      args: [
        '-e',
        'console.log(process.argv[1], process.env.TINYAI_ACTION_SECRET ?? "clean")',
        'hello world',
      ],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'hello world clean\n',
      stderr: '',
      truncated: false,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    delete process.env.TINYAI_ACTION_SECRET;
  });

  it('rejects shell syntax, non-allowlisted executables and escaping cwd', async () => {
    const root = await workspace();
    const executor = new LocalActionExecutor({
      workspaceRoot: root,
      executableAllowlist: ['node'],
    });
    const signal = new AbortController().signal;
    await expect(
      executor.execute({
        executable: 'node; echo hacked',
        args: [],
        signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_EXECUTABLE_DENIED' });
    await expect(
      executor.execute({
        executable: 'python',
        args: [],
        signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_EXECUTABLE_DENIED' });
    await expect(
      executor.execute({
        executable: 'node',
        args: ['-e', 'console.log("no")'],
        cwd: '..',
        signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_CWD_DENIED' });
  });

  it('caps output and preserves exit status', async () => {
    const root = await workspace();
    const executor = new LocalActionExecutor({
      workspaceRoot: root,
      executableAllowlist: ['node'],
      maxOutputBytes: 8,
    });
    const result = await executor.execute({
      executable: 'node',
      args: ['-e', 'process.stdout.write("1234567890"); process.exit(7)'],
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      exitCode: 7,
      stdout: '12345678',
      truncated: true,
    });
  });

  it('maps timeout and abort to action cancellation errors', async () => {
    const root = await workspace();
    const executor = new LocalActionExecutor({
      workspaceRoot: root,
      executableAllowlist: ['node'],
      killGraceMs: 10,
    });
    await expect(
      executor.execute({
        executable: 'node',
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 25,
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_TIMEOUT' });

    const controller = new AbortController();
    const pending = executor.execute({
      executable: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_CANCELLED' });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tinyai-local-action-'));
  roots.push(root);
  return root;
}
