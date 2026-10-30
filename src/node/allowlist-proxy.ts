import { createServer, request as httpRequest, type Server } from 'node:http';
import { connect as netConnect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { NetworkPolicy, type NetworkPolicyOptions } from '../core/network-policy';
import { AgentError } from '../core/errors';

export interface AllowlistProxyOptions extends NetworkPolicyOptions {
  port?: number;
  host?: string;
}

export class AllowlistProxy {
  readonly policy: NetworkPolicy;
  private server?: Server;

  constructor(private readonly options: AllowlistProxyOptions) {
    this.policy = new NetworkPolicy(options);
  }

  async start(): Promise<number> {
    if (this.server) {
      const address = this.server.address();
      if (address && typeof address !== 'string') return address.port;
    }
    const server = createServer(async (request, response) => {
      try {
        const target = new URL(request.url ?? '');
        const resolved = await resolveHost(target.hostname);
        this.policy.assert(target.toString(), resolved);
        const upstream = httpRequest(
          target,
          {
            method: request.method,
            headers: { ...request.headers, host: target.host },
          },
          (upstreamResponse) => {
            response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
            upstreamResponse.pipe(response);
          }
        );
        upstream.on('error', (error) => {
          if (!response.headersSent) response.writeHead(502);
          response.end(error.message);
        });
        request.pipe(upstream);
      } catch (error) {
        const status = error instanceof AgentError && error.code === 'NETWORK_DENIED' ? 403 : 400;
        response.writeHead(status, { 'Content-Type': 'text/plain' });
        response.end(error instanceof Error ? error.message : String(error));
      }
    });
    server.on('connect', async (request, clientSocket, head) => {
      try {
        const [host, portText] = splitHostPort(request.url ?? '');
        const resolved = await resolveHost(host);
        this.policy.assert(`https://${host}:${portText}/`, resolved);
        const upstream = netConnect(Number(portText), host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head.length) upstream.write(head);
          upstream.pipe(clientSocket);
          clientSocket.pipe(upstream);
        });
        upstream.on('error', () => clientSocket.destroy());
      } catch (error) {
        clientSocket.end(
          `HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\n${error instanceof Error ? error.message : String(error)}`
        );
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.options.port ?? 0, this.options.host ?? '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No proxy address');
    return address.port;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

async function resolveHost(host: string): Promise<string[]> {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return [host];
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}

function splitHostPort(value: string): [string, string] {
  const index = value.lastIndexOf(':');
  if (index < 1) throw new Error(`Invalid CONNECT target: ${value}`);
  return [value.slice(0, index).replace(/^\[|\]$/g, ''), value.slice(index + 1) || '443'];
}
