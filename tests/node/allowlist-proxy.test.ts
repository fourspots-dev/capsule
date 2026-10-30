import { createServer } from 'node:http';
import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { AllowlistProxy } from '../../src/node/allowlist-proxy';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('AllowlistProxy', () => {
  it('forwards allowlisted HTTP requests and rejects other hosts', async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('proxied');
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('No upstream');
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve()))
        )
    );

    const proxy = new AllowlistProxy({
      allowHosts: ['127.0.0.1'],
      allowPrivateNetworks: true,
      allowHttp: true,
    });
    const port = await proxy.start();
    cleanups.push(() => proxy.close());

    await expect(
      proxyRequest(
        port,
        `http://127.0.0.1:${upstreamAddress.port}/allowed`
      )
    ).resolves.toEqual({ status: 200, body: 'proxied' });

    const denied = new AllowlistProxy({
      allowHosts: ['example.com'],
      allowPrivateNetworks: true,
      allowHttp: true,
    });
    const deniedPort = await denied.start();
    cleanups.push(() => denied.close());
    const rejected = await proxyRequest(
      deniedPort,
      `http://127.0.0.1:${upstreamAddress.port}/blocked`
    );
    expect(rejected.status).toBe(403);
  });
});

function proxyRequest(
  proxyPort: number,
  target: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        method: 'GET',
        path: target,
      },
      (response) => {
        let body = '';
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}
