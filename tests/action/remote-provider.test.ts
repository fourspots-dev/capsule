import { describe, expect, it, vi } from 'vitest';
import { RemoteActionProvider } from '../../src/adapters/remote-action-provider';

describe('REQ-ACTION-001 remote Action provider', () => {
  it('uses the shared descriptor and ActionResult contract', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const provider = new RemoteActionProvider({
      endpoint: 'https://actions.example.test/rpc',
      token: 'token',
      fetch: vi.fn(async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        requests.push(body);
        if (body.type === 'describe') {
          return jsonResponse({
            actions: [
              {
                id: 'app.remote.check',
                version: '1.2.0',
                title: 'Remote check',
                description: 'Run a remote check',
                inputSchema: { type: 'object', properties: {} },
                outputSchema: { type: 'object', properties: {} },
                effects: ['execute'],
                risk: 'dangerous',
                workspaceBinding: 'remote',
                probe: { state: 'available' },
              },
            ],
          });
        }
        return jsonResponse({
          result: {
            status: 'succeeded',
            value: { passed: true },
            exitCode: 0,
            durationMs: 12,
            artifactIds: ['artifact_remote'],
          },
        });
      }) as typeof fetch,
    });
    const descriptors = await provider.describe();
    expect(descriptors[0]).toMatchObject({
      id: 'app.remote.check',
      version: '1.2.0',
      risk: 'dangerous',
      workspaceBinding: 'remote',
    });
    const result = await provider.invoke(
      'app.remote.check',
      {},
      {
        sessionId: 's',
        taskId: 't',
        requestId: 'request_1',
        workspaceId: 'workspace_1',
        workspaceGeneration: 3,
        environmentFingerprint: 'env-a',
        signal: new AbortController().signal,
      }
    );
    expect(result).toEqual({
      status: 'succeeded',
      value: { passed: true },
      exitCode: 0,
      durationMs: 12,
      artifactIds: ['artifact_remote'],
    });
    expect(requests[1]).toMatchObject({
      type: 'invoke',
      actionId: 'app.remote.check',
      context: {
        requestId: 'request_1',
        workspaceId: 'workspace_1',
        workspaceGeneration: 3,
      },
    });
  });

  it('surfaces HTTP failures without producing a false success', async () => {
    const provider = new RemoteActionProvider({
      endpoint: 'https://actions.example.test/rpc',
      fetch: vi.fn(async () => new Response('offline', { status: 503 })) as typeof fetch,
    });
    await expect(provider.describe()).rejects.toMatchObject({
      code: 'REMOTE_ACTION_HTTP_ERROR',
    });
    await expect(
      provider.invoke('app.remote.check', {}, {
        sessionId: 's',
        taskId: 't',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({
      code: 'REMOTE_ACTION_HTTP_ERROR',
    });
  });

  it('ignores a late remote response after cancellation', async () => {
    const provider = new RemoteActionProvider({
      endpoint: 'https://actions.example.test/rpc',
      fetch: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return jsonResponse({
          result: {
            status: 'succeeded',
            value: { tooLate: true },
          },
        });
      }) as typeof fetch,
    });
    const controller = new AbortController();
    const pending = provider.invoke('app.remote.check', {}, {
      sessionId: 's',
      taskId: 't',
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ code: 'ACTION_CANCELLED' });
  });

  it('filters descriptors and invocations through the configured allowlist', async () => {
    const provider = new RemoteActionProvider({
      endpoint: 'https://actions.example.test/rpc',
      allowedActionIds: ['allowed.action'],
      fetch: vi.fn(async () =>
        jsonResponse({
          actions: [
            {
              id: 'allowed.action',
              version: '1.0.0',
              title: 'Allowed',
              description: 'Allowed',
              inputSchema: { type: 'object', properties: {} },
              effects: ['read'],
              risk: 'read',
            },
            {
              id: 'blocked.action',
              version: '1.0.0',
              title: 'Blocked',
              description: 'Blocked',
              inputSchema: { type: 'object', properties: {} },
              effects: ['read'],
              risk: 'read',
            },
          ],
        })
      ) as typeof fetch,
    });
    expect((await provider.describe()).map((item) => item.id)).toEqual([
      'allowed.action',
    ]);
    await expect(
      provider.invoke('blocked.action', {}, {
        sessionId: 's',
        taskId: 't',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
