import { describe, expect, it } from 'vitest';
import {
  MemoryFileSystem,
  VirtualShell,
  type VirtualCommandProvider,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('VirtualShell', () => {
  it('supports quoting, variables and working-directory state', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.mkdir('src', { recursive: true });
    const shell = new VirtualShell(vfs, { env: { BASE: 'base' } });
    expect(await shell.execute('echo "hello world"')).toMatchObject({
      exitCode: 0,
      stdout: 'hello world\n',
    });
    expect(await shell.execute('VALUE=local; echo $VALUE $BASE')).toMatchObject({
      stdout: 'local base\n',
    });
    expect(await shell.execute('cd src; pwd')).toMatchObject({
      stdout: 'src\n',
    });
    expect(await shell.execute('false; echo $?')).toMatchObject({
      stdout: '1\n',
    });
  });

  it('supports pipelines, redirects and input redirection', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    await shell.execute('echo alpha > words.txt');
    await shell.execute('echo beta >> words.txt');
    expect(decoder.decode(await vfs.read('words.txt'))).toBe('alpha\nbeta\n');
    expect(await shell.execute('grep beta < words.txt')).toMatchObject({
      exitCode: 0,
      stdout: '2:beta\n',
    });
    expect(await shell.execute('grep -n beta words.txt')).toMatchObject({
      exitCode: 0,
      stdout: '2:beta\n',
    });
    expect(await shell.execute('echo ignored | grep alpha')).toMatchObject({
      exitCode: 1,
      stdout: '',
    });
  });

  it('accepts common read-only diff flags', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    await vfs.write('before.txt', encoder.encode('old\n'));
    await vfs.write('after.txt', encoder.encode('new\n'));
    expect(await shell.execute('diff -u before.txt after.txt')).toMatchObject({
      exitCode: 1,
      stdout: expect.stringContaining('-old'),
    });
  });

  it('short-circuits logical groups and preserves the final exit code', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    expect(await shell.execute('false && echo no || echo yes')).toMatchObject({
      exitCode: 0,
      stdout: 'yes\n',
    });
    expect(await shell.execute('true && echo yes; false')).toMatchObject({
      exitCode: 1,
      stdout: 'yes\n',
    });
  });

  it('implements the documented VFS file commands without host filesystem access', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    await shell.execute(
      'mkdir -p src/nested && echo first > src/a.txt && cp src/a.txt src/b.txt'
    );
    await shell.execute('mv src/b.txt src/c.txt');
    expect(await shell.execute('find src')).toMatchObject({
      exitCode: 0,
      stdout: 'src/a.txt\nsrc/c.txt\nsrc/nested\n',
    });
    await shell.execute('rm -r src/nested');
    expect(await vfs.stat('src/nested')).toBeUndefined();
  });

  it('returns structured errors for unsupported syntax and missing commands', async () => {
    const shell = new VirtualShell(new MemoryFileSystem());
    await expect(shell.execute('echo $(uname)')).rejects.toMatchObject({
      code: 'SHELL_SYNTAX_UNSUPPORTED',
    });
    await expect(shell.execute('echo `uname`')).rejects.toMatchObject({
      code: 'SHELL_SYNTAX_UNSUPPORTED',
    });
    expect(await shell.execute('does-not-exist')).toMatchObject({
      exitCode: 127,
      stderr: 'does-not-exist: command not found\n',
    });
  });

  it('passes cancellation to command providers and truncates large output', async () => {
    const controller = new AbortController();
    const provider: VirtualCommandProvider = {
      canExecute: (command) => command === 'wait',
      execute: async (request) => {
        if (!request.signal?.aborted) {
          await new Promise<void>((resolve, reject) => {
            request.signal?.addEventListener(
              'abort',
              () => reject(new Error('provider cancelled')),
              { once: true }
            );
          });
        }
        throw new Error('provider cancelled');
      },
    };
    const shell = new VirtualShell(new MemoryFileSystem(), {
      providers: [provider],
      maxOutputChars: 5,
    });
    const pending = shell.execute('wait', { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow('provider cancelled');
    expect(
      await shell.execute('echo 123456789', {
        signal: new AbortController().signal,
      })
    ).toMatchObject({
      stdout: '12345\n…(truncated)',
    });
  });

  it('rewrites files only through the supplied VFS', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    await vfs.write('input.txt', encoder.encode('virtual\n'));
    expect(await shell.execute('cat input.txt')).toMatchObject({
      stdout: 'virtual\n',
    });
  });

  it('supports virtual devices, capability discovery and inspection builtins', async () => {
    const vfs = new MemoryFileSystem();
    const shell = new VirtualShell(vfs);
    expect(await shell.execute('printf "one\\ntwo\\n" > values.txt')).toMatchObject({
      exitCode: 0,
    });
    expect(await shell.execute('echo hidden > /dev/null')).toMatchObject({
      exitCode: 0,
      stdout: '',
    });
    expect(await vfs.stat('dev/null')).toBeUndefined();
    expect(await shell.execute('cat /dev/null')).toMatchObject({
      exitCode: 0,
      stdout: '',
    });
    expect(await shell.execute('which node echo')).toMatchObject({
      exitCode: 1,
      stdout: 'echo\n',
    });
    expect(await shell.execute('uname')).toMatchObject({
      stdout: 'tinyai-virtual\n',
    });
    expect(await shell.execute('head -n 1 values.txt')).toMatchObject({
      stdout: 'one\n',
    });
    expect(await shell.execute('tail -n 1 values.txt')).toMatchObject({
      stdout: 'two\n',
    });
    expect(await shell.execute('wc -l values.txt')).toMatchObject({
      stdout: '2 values.txt\n',
    });
    expect(await shell.execute('[ -f values.txt ]')).toMatchObject({
      exitCode: 0,
    });
    expect(await shell.execute('touch empty.txt')).toMatchObject({
      exitCode: 0,
    });
    expect(await vfs.stat('empty.txt')).toMatchObject({ size: 0 });
  });
});
