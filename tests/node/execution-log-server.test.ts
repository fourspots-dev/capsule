import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecutionEventInput } from '../../src/observability/execution-event';
import { ExecutionEventHub } from '../../src/observability/execution-hub';
import { ExecutionLogServer } from '../../src/node/execution-log-server';
import { NdjsonExecutionLogStore } from '../../src/node/execution-log-store';
import { testDebugService } from '../../src/observability/debug-service-config';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((task) => task()));
});

describe('REQ-OBS-001 execution log server', () => {
  it('authenticates ingest and supports cursor query, export and SSE', async () => {
    const hub = new ExecutionEventHub({ epoch: 'epoch_http' });
    const server = new ExecutionLogServer({
      hub,
      token: 'pairing-token',
      port: 0,
    });
    const address = await server.start();
    cleanup.push(() => server.stop());
    const base = address.baseUrl;
    const headers = {
      Authorization: 'Bearer pairing-token',
      'content-type': 'application/json',
    };

    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/v1/sessions`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/v1/sessions`, {
          headers: { Authorization: 'Bearer wrong-token' },
        })
      ).status
    ).toBe(401);
    await expect(
      testDebugService({ endpoint: base, token: 'pairing-token' })
    ).resolves.toBeUndefined();
    await expect(
      testDebugService({ endpoint: base, token: 'wrong-token' })
    ).rejects.toThrow('rejected');
    const ingest = await fetch(`${base}/v1/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        events: [event('one', 1), event('two', 2)],
      }),
    });
    expect(ingest.status).toBe(200);
    expect(await ingest.json()).toMatchObject({
      ok: true,
      accepted: [{ clientEventId: 'one' }, { clientEventId: 'two' }],
    });

    const first = (await (
      await fetch(`${base}/v1/sessions/session_1/events?limit=1`, { headers })
    ).json()) as {
      events: Array<{ sequence: number }>;
      nextCursor: string;
      hasMore: boolean;
    };
    expect(first.events).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    const second = (await (
      await fetch(
        `${base}/v1/sessions/session_1/events?after=${encodeURIComponent(first.nextCursor)}`,
        { headers }
      )
    ).json()) as { events: Array<{ sequence: number }> };
    expect(second.events).toHaveLength(1);
    const invalidCursor = await fetch(
      `${base}/v1/sessions/session_1/events?after=invalid`,
      { headers }
    );
    expect(invalidCursor.status).toBe(400);
    expect(await invalidCursor.json()).toMatchObject({
      error: { code: 'CURSOR_INVALID' },
    });
    expect(
      (
        await fetch(`${base}/v1/command`, {
          method: 'POST',
          headers,
          body: '{}',
        })
      ).status
    ).toBe(404);

    const exported = await fetch(`${base}/v1/sessions/session_1/export`, {
      headers,
    });
    expect(exported.headers.get('content-type')).toContain(
      'application/x-ndjson'
    );
    expect((await exported.text()).trim().split('\n')).toHaveLength(2);

    const abort = new AbortController();
    const stream = await fetch(
      `${base}/v1/sessions/session_1/stream?after=${encodeURIComponent(first.nextCursor)}`,
      { headers, signal: abort.signal }
    );
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"clientEventId":"three"')) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
      if (text.includes('"clientEventId":"two"')) {
        await fetch(`${base}/v1/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ events: [event('three', 3)] }),
        });
      }
    }
    expect(text).toContain('"clientEventId":"three"');
    abort.abort();
    await reader.cancel().catch(() => undefined);
  });

  it('persists events and restores the same cursor epoch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tinyai-debug-store-'));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const firstStore = new NdjsonExecutionLogStore(dir, 10);
    const restored = await firstStore.load();
    const firstHub = new ExecutionEventHub({
      epoch: 'epoch_persist',
      initialEvents: restored.events,
      store: firstStore,
    });
    await firstStore.setEpoch(firstHub.cursorEpoch);
    await firstHub.ingest([event('stored', 1)]);

    const secondStore = new NdjsonExecutionLogStore(dir, 10);
    const loaded = await secondStore.load();
    expect(loaded.epoch).toBe('epoch_persist');
    const secondHub = new ExecutionEventHub({
      epoch: loaded.epoch,
      initialEvents: loaded.events,
      store: secondStore,
    });
    expect(secondHub.query('session_1').events).toHaveLength(1);
  });
});

function event(clientEventId: string, timestamp: number): ExecutionEventInput {
  return {
    clientEventId,
    timestamp,
    sessionId: 'session_1',
    kind: 'tool',
    phase: 'completed',
    actor: 'tool',
    payload: { text: clientEventId },
  };
}
