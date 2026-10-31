import { describe, expect, it } from 'vitest';
import { createRemoteRunnerHandler } from '../../src/node/remote-runner-server';
import {
  createWorkspaceBundle,
  parseWorkspaceBundle,
} from '../../src/virtual';

describe('Remote runner server', () => {
  const handler = createRemoteRunnerHandler({
    token: 'secret',
    allowedCommands: ['/bin/sh'],
    timeoutMs: 5_000,
  });

  it('authenticates, executes a command and returns workspace changes', async () => {
    const response = await handler(
      new Request('http://runner.test/execute', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          command: '/bin/sh',
          args: ['-c', 'printf changed > value.txt && printf ok'],
          cwd: '',
          env: {},
          stdin: '',
          workspace: createWorkspaceBundle({
            files: [{ path: 'value.txt', dataBase64: btoa('original') }],
          }),
        }),
      })
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      exitCode: number;
      stdout: string;
      workspace: ReturnType<typeof createWorkspaceBundle>;
    };
    expect(result).toMatchObject({ exitCode: 0, stdout: 'ok' });
    const workspace = parseWorkspaceBundle(result.workspace);
    expect(
      Buffer.from(workspace.files[0].dataBase64, 'base64').toString('utf8')
    ).toBe('changed');
  });

  it('rejects missing auth and non-allowlisted commands', async () => {
    expect(
      (
        await handler(
          new Request('http://runner.test/execute', {
            method: 'POST',
            body: '{}',
          })
        )
      ).status
    ).toBe(401);
    const denied = await handler(
      new Request('http://runner.test/execute', {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          command: '/usr/bin/curl',
          args: [],
          cwd: '',
          env: {},
          stdin: '',
          workspace: createWorkspaceBundle({ files: [] }),
        }),
      })
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: 'REMOTE_COMMAND_DENIED' });
  });
});
