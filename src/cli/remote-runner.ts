import { createServer } from 'node:http';
import { createRemoteRunnerHandler } from '../node/remote-runner-server';

const token = process.env.TINYAI_RUNNER_TOKEN;
const commands = (process.env.TINYAI_RUNNER_COMMANDS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
if (!token) throw new Error('TINYAI_RUNNER_TOKEN is required');
if (!commands.length) throw new Error('TINYAI_RUNNER_COMMANDS is required');
const port = Number(process.env.TINYAI_RUNNER_PORT ?? 8787);
const handler = createRemoteRunnerHandler({
  token,
  allowedCommands: commands,
  timeoutMs: Number(process.env.TINYAI_RUNNER_TIMEOUT_MS ?? 300_000),
});

const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', async () => {
    try {
      const result = await handler(
        new Request(`http://${request.headers.host ?? `127.0.0.1:${port}`}${request.url}`, {
          method: request.method,
          headers: request.headers as Record<string, string>,
          body: request.method === 'GET' ? undefined : Buffer.concat(chunks),
        })
      );
      response.statusCode = result.status;
      result.headers.forEach((value, key) => response.setHeader(key, value));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch (error) {
      response.statusCode = 500;
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  });
});
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`tinyai remote runner listening on http://127.0.0.1:${port}\n`);
});
