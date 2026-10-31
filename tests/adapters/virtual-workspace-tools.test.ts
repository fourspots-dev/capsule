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
        '*** Begin Patch',
        '*** Update File: src/value.ts',
        '@@',
        '-export const value = 1;',
        '+export const value = 2;',
        '+export const doubled = value * 2;',
        '*** End Patch',
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
    expect(
      await execute(executor, 'exec', {
        command: 'echo',
        args: ['command-args'],
        cwd: 'src',
      })
    ).toMatchObject({
      output: { exitCode: 0, stdout: 'command-args\n' },
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

  it('offers line-oriented reads and exact text replacement for reliable edits', async () => {
    const { executor, workspace } = setup();
    await execute(executor, 'write_file', {
      path: 'src/player.js',
      text: 'var a = 1;\nvar broken = true;\nvar c = 3;\n',
    });
    expect(
      await execute(executor, 'read_file', {
        path: 'src/player.js',
        start_line: 2,
        end_line: 2,
      })
    ).toMatchObject({
      output: { text: 'var broken = true;' },
    });
    await execute(executor, 'replace_in_file', {
      path: 'src/player.js',
      old_text: 'var broken = true;',
      new_text: 'var fixed = true;',
    });
    expect(new TextDecoder().decode(await workspace.fs.read('src/player.js'))).toBe(
      'var a = 1;\nvar fixed = true;\nvar c = 3;\n'
    );
    await execute(executor, 'append_file', {
      path: 'src/player.js',
      text: 'var d = 4;\n',
    });
    expect(new TextDecoder().decode(await workspace.fs.read('src/player.js'))).toBe(
      'var a = 1;\nvar fixed = true;\nvar c = 3;\nvar d = 4;\n'
    );
    await execute(executor, 'write_file', {
      path: 'src/player.js',
      text: 'same\nsame\n',
    });
    await expect(
      execute(executor, 'replace_in_file', {
        path: 'src/player.js',
        old_text: 'same',
        new_text: 'other',
      })
    ).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'EDIT_TEXT_AMBIGUOUS' },
    });
  });

  it('separates contextual apply_patch from strict unified diff input', async () => {
    const { executor, workspace } = setup();
    await execute(executor, 'write_file', {
      path: 'a.txt',
      text: 'old\n',
    });
    await expect(
      execute(executor, 'apply_patch', {
        patch: [
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1 +1 @@',
          '-old',
          '+context',
          '',
        ].join('\n'),
      })
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'PATCH_PROTOCOL_INVALID',
        details: { suggestion: expect.stringContaining('apply_unified_diff') },
      },
    });
    await execute(executor, 'apply_unified_diff', {
      patch: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1 +1 @@',
        '-old',
        '+unified',
        '',
      ].join('\n'),
    });
    expect(new TextDecoder().decode(await workspace.fs.read('a.txt'))).toBe(
      'unified\n'
    );
  });

  it('blocks a fourth identical failed patch instead of retrying forever', async () => {
    const { executor } = setup();
    await execute(executor, 'write_file', {
      path: 'a.txt',
      text: 'current\n',
    });
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-missing',
      '+other',
      '*** End Patch',
    ].join('\n');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        execute(executor, 'apply_patch', { patch })
      ).resolves.toMatchObject({
        status: 'failed',
        error: { code: 'PATCH_CONTEXT_NOT_FOUND' },
      });
    }
    await expect(
      execute(executor, 'apply_patch', { patch })
    ).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'TOOL_RETRY_BLOCKED',
        details: { retryCount: 3 },
      },
    });
  });

  it('advertises distinct ContextPatch and unified diff contracts', () => {
    const { executor } = setup();
    const descriptors = new Map(
      executor.descriptors().map((descriptor) => [descriptor.name, descriptor])
    );
    expect(descriptors.get('apply_patch')?.description).toContain(
      '*** Begin Patch'
    );
    expect(descriptors.get('apply_patch')?.description).toContain(
      'Do not provide unified-diff hunk counts'
    );
    expect(
      descriptors.get('apply_patch')?.parameters.properties
    ).toMatchObject({
      patch: {
        description: expect.stringContaining('Do not use unified-diff headers'),
      },
    });
    expect(descriptors.get('apply_unified_diff')?.description).toContain(
      'exact @@ hunk counts'
    );
    expect(descriptors.has('git_status')).toBe(true);
    expect(descriptors.has('git_commit')).toBe(true);
    expect(descriptors.has('git_log')).toBe(true);
  });

  it('initializes and commits through the portable Git tool pack', async () => {
    const { executor, workspace } = setup();
    await execute(executor, 'write_file', {
      path: 'src/main.js',
      text: 'console.log("space");\n',
    });
    await execute(executor, 'git_add', {
      paths: ['src'],
    }).then((result) => {
      expect(result.status).toBe('failed');
      expect(result.error?.code).toBe('GIT_REPOSITORY_NOT_FOUND');
    });
    const init = await execute(executor, 'git_init', {});
    expect(init.status).toBe('succeeded');
    await execute(executor, 'git_add', { paths: ['src'] });
    await execute(executor, 'git_commit', { message: 'ship the game' });
    const log = await execute(executor, 'git_log', {});
    expect(log.output).toMatchObject([
      { message: 'ship the game\n' },
    ]);
    expect(descriptorToolDefinitions(executor, 'git_status')).toBeDefined();
    expect(new TextDecoder().decode(await workspace.fs.read('src/main.js'))).toContain(
      'space'
    );
  });
});

function descriptorToolDefinitions(executor: ToolExecutor, name: string) {
  return executor.descriptors().find((tool) => tool.name === name);
}

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
