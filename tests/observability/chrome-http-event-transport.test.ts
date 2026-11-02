import { describe, expect, it, vi } from 'vitest';
import { ChromeHttpEventTransport } from '../../src/observability/chrome-http-event-transport';
import {
  normalizeEndpoint,
  parseDebugServiceConfig,
} from '../../src/observability/debug-service-config';
import type { ExecutionEventInput } from '../../src/observability/execution-event';

describe('REQ-OBS-001 Chrome debug transport', () => {
  it('accepts local HTTP and remote HTTPS but rejects remote cleartext', () => {
    expect(normalizeEndpoint('http://127.0.0.1:4399/')).toBe(
      'http://127.0.0.1:4399'
    );
    expect(normalizeEndpoint('https://debug.example.com/v1/')).toBe(
      'https://debug.example.com/v1'
    );
    expect(normalizeEndpoint('http://debug.example.com')).toBeUndefined();
    expect(
      parseDebugServiceConfig({
        enabled: true,
        endpoint: 'http://localhost:4399',
        token: 'secret',
      })
    ).toEqual({
      enabled: true,
      endpoint: 'http://localhost:4399',
      token: 'secret',
    });
  });

  it('ACKs batches and retains events after service failure', async () => {
    const requests: Array<Record<string, unknown>> = [];
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response('offline', { status: 503 }));
    const transport = new ChromeHttpEventTransport({
      config: {
        enabled: true,
        endpoint: 'http://127.0.0.1:4399',
        token: 'token',
      },
      fetch: fetcher as typeof fetch,
      setTimeout: () => 1 as never,
      clearTimeout: () => undefined,
    });
    transport.emit(event('one'));
    await transport.flush();
    expect(transport.status()).toMatchObject({ queued: 0, state: 'ready' });

    transport.emit(event('two'));
    await transport.flush();
    expect(transport.status()).toMatchObject({
      queued: 1,
      state: 'retrying',
    });
    requests.push(
      JSON.parse(String(fetcher.mock.calls[0][1]?.body)) as Record<string, unknown>
    );
    expect(requests[0].events).toHaveLength(1);
  });

  it('bounds queued debug payloads by both item count and bytes', () => {
    const transport = new ChromeHttpEventTransport({
      config: {
        enabled: true,
        endpoint: 'http://127.0.0.1:4399',
        token: 'token',
      },
      fetch: vi.fn() as typeof fetch,
      maxQueue: 100,
      maxQueuedBytes: 1_000,
      setTimeout: () => 1 as never,
      clearTimeout: () => undefined,
    });
    for (let index = 0; index < 20; index += 1) {
      transport.emit({
        ...event(`large_${index}`),
        payload: { text: 'x'.repeat(200) },
      });
    }
    expect(transport.status().queuedBytes).toBeLessThanOrEqual(1_000);
    expect(transport.status().queued).toBeLessThan(20);
  });
});

function event(clientEventId: string): ExecutionEventInput {
  return {
    clientEventId,
    timestamp: 1,
    sessionId: 'session_1',
    kind: 'assistant',
    phase: 'updated',
    actor: 'agent',
    payload: { text: clientEventId },
  };
}
