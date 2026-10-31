import { describe, expect, it } from 'vitest';
import { createVirtualWorkspaceTools } from '../../src/adapters/virtual-workspace-tools';
import { ToolExecutor } from '../../src/core';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';
import { FakeApproval } from '../harness/fakes';

function setup() {
  const workspace = new VirtualWorkspace({
    host: new MemoryHostBridge(),
    storageKey: `test:workspace:${Math.random().toString(36).slice(2)}`,
  });
  const executor = new ToolExecutor(
    createVirtualWorkspaceTools(workspace),
    new FakeApproval(true)
  );
  return { workspace, executor };
}

describe('virtual workspace agent tools', () => {
  it('edits, searches and patches only through the virtual workspace', async () => {
    const { workspace, executor } = setup();
    await execute(executor, 'write_file', {
      path: 'src/value.ts',
      text: 'export const value = 1;\n',
    });
    expect(
      await execute(executor, 'read_file', { path: 'src/value.ts' })
    ).toMatchObject({
      output: { text: 'export const value = 1;\n', bytes: 24 },
    });
    expect(
      await execute(executor, 'search', { pattern: 'value', include: ['**/*.ts'] })
    ).toMatchObject({
      output: [expect.objectContaining({ path: 'src/value.ts', line: 1 })],
    });

    await execute(executor, 'apply_patch', {
      patch: [
        '--- a/src/value.ts',
        '+++ b/src/value.ts',
        '@@ -1,1 +1,2 @@',
        '-export const value = 1;',
        '+export const value = 2;',
        '+export const doubled = value * 2;',
        '',
      ].join('\n'),
    });
    expect(new TextDecoder().decode(await workspace.fs.read('src/value.ts'))).toBe(
      'export const value = 2;\nexport const doubled = value * 2;\n'
    );

    await execute(executor, 'exec', {
      script: 'echo virtual-shell',
      stdin: '',
    }).then((result) => {
      expect(result).toMatchObject({
        output: { exitCode: 0, stdout: 'virtual-shell\n' },
      });
    });
  });

  it('exposes expected-version conflicts and background jobs', async () => {
    const { executor } = setup();
    await execute(executor, 'write_file', { path: 'a.txt', text: 'one' });
    await expect(
      execute(executor, 'write_file', {
        path: 'a.txt',
        text: 'two',
        expected_version: 99,
      })
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'VFS_VERSION_CONFLICT' },
    });

    const started = await execute(executor, 'job_start', { script: 'echo async' });
    const jobId = (started.output as { id: string }).id;
    let job = await execute(executor, 'job_read', { job_id: jobId });
    for (let attempt = 0; attempt < 20 && (job.output as { status: string }).status === 'running'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      job = await execute(executor, 'job_read', { job_id: jobId });
    }
    expect(job).toMatchObject({
      output: expect.objectContaining({
        id: jobId,
        status: 'completed',
        stdout: 'async\n',
      }),
    });
  });
});

async function execute(
  executor: ToolExecutor,
  name: string,
  input: Record<string, unknown>
) {
  return executor.execute({
    sessionId: 'session',
    taskId: 'task',
    signal: new AbortController().signal,
    call: {
      id: `call_${name}`,
      name,
      arguments: JSON.stringify(input),
    },
  });
}
