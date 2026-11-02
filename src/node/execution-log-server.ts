import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  ExecutionEvent,
  ExecutionEventInput,
} from '../observability/execution-event';
import { ExecutionEventHub } from '../observability/execution-hub';

export interface ExecutionLogServerOptions {
  hub: ExecutionEventHub;
  token: string;
  host?: string;
  port?: number;
  maxBodyBytes?: number;
}

export class ExecutionLogServer {
  private server?: Server;
  private readonly host: string;
  private readonly port: number;
  private readonly maxBodyBytes: number;

  constructor(private readonly options: ExecutionLogServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? 4399;
    this.maxBodyBytes = options.maxBodyBytes ?? 2 * 1024 * 1024;
  }

  async start(): Promise<{ host: string; port: number; baseUrl: string }> {
    if (this.server) throw new Error('Execution Log Server is already running');
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.port, this.host, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    return {
      host: this.host,
      port: address.port,
      baseUrl: `http://${this.host}:${address.port}`,
    };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    this.setCors(response);
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${this.host}`);
    if (request.method === 'GET' && url.pathname === '/healthz') {
      this.json(response, 200, {
        ok: true,
        service: 'tinyai-debug-hub',
        schemaVersion: 1,
      });
      return;
    }
    if (!this.authorized(request.headers.authorization)) {
      this.json(response, 401, {
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'A valid Bearer token is required' },
      });
      return;
    }
    try {
      if (request.method === 'POST' && url.pathname === '/v1/ingest') {
        const body = await this.readJson(request);
        const events = (body as { events?: unknown }).events;
        if (!Array.isArray(events) || !events.every(isEventInput)) {
          throw new HttpError(400, 'EVENTS_INVALID', 'events must be an execution event array');
        }
        const result = await this.options.hub.ingest(events);
        this.json(response, 200, {
          ok: true,
          accepted: result.accepted.map((event) => ({
            eventId: event.eventId,
            clientEventId: event.clientEventId,
            cursor: event.cursor,
          })),
          duplicates: result.duplicates,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/sessions') {
        this.json(response, 200, {
          ok: true,
          sessions: this.options.hub.listSessions(),
        });
        return;
      }
      const eventsMatch = /^\/v1\/sessions\/([^/]+)\/events$/.exec(url.pathname);
      if (request.method === 'GET' && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1]);
        const result = this.options.hub.query(
          sessionId,
          url.searchParams.get('after') ?? undefined,
          positiveInteger(url.searchParams.get('limit'), 500)
        );
        this.json(response, 200, { ok: true, ...result });
        return;
      }
      const streamMatch = /^\/v1\/sessions\/([^/]+)\/stream$/.exec(url.pathname);
      if (request.method === 'GET' && streamMatch) {
        this.stream(
          response,
          decodeURIComponent(streamMatch[1]),
          url.searchParams.get('after') ?? undefined
        );
        return;
      }
      const exportMatch = /^\/v1\/sessions\/([^/]+)\/export$/.exec(url.pathname);
      if (request.method === 'GET' && exportMatch) {
        const sessionId = decodeURIComponent(exportMatch[1]);
        const body = this.options.hub.exportSession(sessionId);
        response.writeHead(200, {
          'Content-Type': 'application/x-ndjson; charset=utf-8',
          'Content-Disposition': `attachment; filename="${safeFilename(sessionId)}.ndjson"`,
        });
        response.end(body);
        return;
      }
      this.json(response, 404, {
        ok: false,
        error: { code: 'NOT_FOUND', message: 'Unknown Debug Hub route' },
      });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const code =
        error instanceof HttpError
          ? error.code
          : error instanceof Error && error.message === 'CURSOR_EXPIRED'
            ? 'CURSOR_EXPIRED'
            : error instanceof Error && error.message === 'Invalid execution cursor'
              ? 'CURSOR_INVALID'
            : 'DEBUG_HUB_FAILED';
      this.json(
        response,
        code === 'CURSOR_EXPIRED'
          ? 409
          : code === 'CURSOR_INVALID'
            ? 400
            : status,
        {
        ok: false,
        error: {
          code,
          message: error instanceof Error ? error.message : String(error),
        },
        }
      );
    }
  }

  private stream(
    response: ServerResponse,
    sessionId: string,
    after?: string
  ): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const sent = new Set<string>();
    const send = (event: ExecutionEvent): void => {
      if (sent.has(event.eventId)) return;
      sent.add(event.eventId);
      response.write(`id: ${event.cursor}\n`);
      response.write('event: execution\n');
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const subscription = this.options.hub.subscribe(sessionId, send, after);
    for (const event of subscription.initial) send(event);
    const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 15_000);
    heartbeat.unref?.();
    response.on('close', () => {
      clearInterval(heartbeat);
      subscription.unsubscribe();
    });
  }

  private async readJson(request: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > this.maxBodyBytes) {
        throw new HttpError(413, 'BODY_TOO_LARGE', 'Debug event batch is too large');
      }
      chunks.push(buffer);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON_INVALID', 'Request body must be valid JSON');
    }
  }

  private authorized(header: string | undefined): boolean {
    const token = header?.match(/^Bearer\s+(.+)$/i)?.[1];
    return Boolean(token && constantTimeEqual(token, this.options.token));
  }

  private setCors(response: ServerResponse): void {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader(
      'Access-Control-Allow-Headers',
      'authorization, content-type'
    );
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(value));
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function isEventInput(value: unknown): value is ExecutionEventInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const event = value as Partial<ExecutionEventInput>;
  return Boolean(
    typeof event.clientEventId === 'string' &&
      typeof event.timestamp === 'number' &&
      typeof event.sessionId === 'string' &&
      eventKinds.has(String(event.kind)) &&
      eventPhases.has(String(event.phase)) &&
      eventActors.has(String(event.actor)) &&
      (event.visibility === undefined ||
        ['public', 'displayed-reasoning', 'summary'].includes(
          String(event.visibility)
        ))
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function safeFilename(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const eventKinds = new Set([
  'session',
  'user',
  'assistant',
  'reasoning',
  'tool',
  'approval',
  'handoff',
  'child-agent',
  'evidence',
  'artifact',
  'error',
  'status',
]);
const eventPhases = new Set([
  'started',
  'updated',
  'completed',
  'failed',
  'cancelled',
]);
const eventActors = new Set([
  'user',
  'agent',
  'tool',
  'child-agent',
  'system',
]);
