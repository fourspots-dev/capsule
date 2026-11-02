#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ExecutionEventHub } from '../observability/execution-hub';
import { NdjsonExecutionLogStore } from '../node/execution-log-store';
import { ExecutionLogServer } from '../node/execution-log-server';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(
      [
        'Usage: tinyai-debug-server [options]',
        '',
        '  --host <host>         Listen host (default 127.0.0.1)',
        '  --port <port>         Listen port (default 4399; 0 selects a free port)',
        '  --data-dir <path>     NDJSON storage directory (default .tinyai/debug)',
        '  --token <token>       Bearer pairing token (default generated)',
        '  --max-events <count>  In-memory retention limit (default 100000)',
      ].join('\n') + '\n'
    );
    return;
  }
  const dataDir = options.dataDir ?? resolve('.tinyai/debug');
  const store = new NdjsonExecutionLogStore(
    dataDir,
    options.maxEvents ?? 100_000
  );
  const restored = await store.load();
  const hub = new ExecutionEventHub({
    ...(restored.epoch ? { epoch: restored.epoch } : {}),
    initialEvents: restored.events,
    maxEvents: options.maxEvents ?? 100_000,
    store,
  });
  await store.setEpoch(hub.cursorEpoch);
  const token = options.token ?? randomUUID();
  const server = new ExecutionLogServer({
    hub,
    token,
    host: options.host ?? '127.0.0.1',
    port: options.port ?? 4399,
  });
  const address = await server.start();
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        service: 'tinyai-debug-hub',
        ...address,
        token,
        dataDir,
        sessionsUrl: `${address.baseUrl}/v1/sessions`,
        ingestUrl: `${address.baseUrl}/v1/ingest`,
      },
      null,
      2
    ) + '\n'
  );
  const shutdown = async (): Promise<void> => {
    await server.stop();
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
}

function parseArgs(args: string[]): {
  host?: string;
  port?: number;
  dataDir?: string;
  token?: string;
  maxEvents?: number;
  help?: boolean;
} {
  const options: ReturnType<typeof parseArgs> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    if (arg === '--host') options.host = value;
    else if (arg === '--port') options.port = Number(value);
    else if (arg === '--data-dir') options.dataDir = resolve(value);
    else if (arg === '--token') options.token = value;
    else if (arg === '--max-events') options.maxEvents = Number(value);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port < 0)) {
    throw new Error('--port must be a non-negative integer');
  }
  if (
    options.maxEvents !== undefined &&
    (!Number.isInteger(options.maxEvents) || options.maxEvents < 1)
  ) {
    throw new Error('--max-events must be a positive integer');
  }
  return options;
}

void main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
