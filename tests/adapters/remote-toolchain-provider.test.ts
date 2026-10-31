import { describe, expect, it, vi } from 'vitest';
import { RemoteToolchainProvider } from '../../src/adapters/remote-toolchain-provider';
import {
  createWorkspaceBundle,
  MemoryFileSystem,
  parseWorkspaceBundle,
  serializeWorkspaceBundle,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('RemoteToolchainProvider', () => {
  it('sends the workspace, executes remotely and applies returned changes', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('src/value.ts', encoder.encode('export const value = 1;\n'));
    let request: Record<string, unknown> | undefined;
    const remoteBundle = createWorkspaceBundle({
      files: [
        {
          path: 'src/value.ts',
          dataBase64: btoa('export const value = 2;\n'),
        },
        {
          path: 'test/report.txt',
          dataBase64: btoa('passed'),
        },
      ],
    });
    const provider = new RemoteToolchainProvider({
      endpoint: 'https://runner.example.test/execute',
      token: 'runner-token',
      workspace: vfs,
      commandAllowlist: ['node'],
      fetch: vi.fn(async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            exitCode: 0,
            stdout: 'tests passed\n',
            stderr: '',
            workspace: remoteBundle,
            revision: 'remote-1',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }) as typeof fetch,
    });
    const result = await provider.execute({
      command: 'node',
      args: ['--test'],
      cwd: 'src',
      env: { CI: '1' },
      stdin: '',
    });
    expect(result).toEqual({ exitCode: 0, stdout: 'tests passed\n', stderr: '' });
    expect(request).toMatchObject({
      command: 'node',
      args: ['--test'],
      cwd: 'src',
      env: { CI: '1' },
    });
    const sentWorkspace = parseWorkspaceBundle(
      request?.workspace as ReturnType<typeof createWorkspaceBundle>
    );
    expect(sentWorkspace.files[0].path).toBe('src/value.ts');
    expect(decoder.decode(await vfs.read('src/value.ts'))).toBe(
      'export const value = 2;\n'
    );
    expect(decoder.decode(await vfs.read('test/report.txt'))).toBe('passed');
  });

  it('rejects non-allowlisted commands and HTTP failures without mutating the workspace', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('keep.txt', encoder.encode('keep'));
    const fetch = vi.fn(async () => new Response('denied', { status: 403 }));
    const provider = new RemoteToolchainProvider({
      endpoint: 'https://runner.example.test/execute',
      workspace: vfs,
      commandAllowlist: ['node'],
      fetch: fetch as typeof globalThis.fetch,
    });
    await expect(
      provider.execute(request('python'))
    ).rejects.toMatchObject({ code: 'REMOTE_COMMAND_DENIED' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      provider.execute(request('node'))
    ).rejects.toMatchObject({ code: 'REMOTE_RUNNER_HTTP_ERROR' });
    expect(decoder.decode(await vfs.read('keep.txt'))).toBe('keep');
  });
});

function request(command: string) {
  return {
    command,
    args: [],
    cwd: '',
    env: {},
    stdin: '',
  };
}
