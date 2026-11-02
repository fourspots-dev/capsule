import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ExecutionEventHub } from '../../src/observability/execution-hub';
import { ExecutionLogServer } from '../../src/node/execution-log-server';

const debugToken = 'e2e-debug-token';
let modelServer: Server;
let modelUrl: string;
let debugServer: ExecutionLogServer;
let debugUrl: string;
let hub: ExecutionEventHub;
let debugIngestCalls = 0;
let context: BrowserContext;
let userDataDir: string;
const workerLogs: string[] = [];

beforeAll(async () => {
  modelServer = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string; tool_calls?: unknown[] }>;
      };
      const toolMessages = (parsed.messages ?? []).filter(
        (message) => message.role === 'tool'
      );
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      if (toolMessages.length === 0) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'Inspect the workspace before responding.',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_debug_list',
                      function: {
                        name: 'list_files',
                        arguments: '{"path":""}',
                      },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          })}\n\n`
        );
      } else {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 'The workspace inspection completed.',
                  content: 'Debug trace complete',
                },
                finish_reason: 'stop',
              },
            ],
          })}\n\n`
        );
      }
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolveServer) =>
    modelServer.listen(0, '127.0.0.1', () => resolveServer())
  );
  const modelAddress = modelServer.address();
  if (!modelAddress || typeof modelAddress === 'string') {
    throw new Error('No model server address');
  }
  modelUrl = `http://127.0.0.1:${modelAddress.port}/v1`;

  hub = new ExecutionEventHub({ epoch: 'e2e_debug' });
  const ingest = hub.ingest.bind(hub);
  hub.ingest = async (events) => {
    debugIngestCalls += 1;
    return ingest(events);
  };
  debugServer = new ExecutionLogServer({ hub, token: debugToken, port: 0 });
  const debugAddress = await debugServer.start();
  debugUrl = debugAddress.baseUrl;

  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-debug-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: chromeExecutable(),
    args: [
      `--disable-extensions-except=${resolve('extension')}`,
      `--load-extension=${resolve('extension')}`,
      '--no-first-run',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
  context.on('serviceworker', (worker) => {
    worker.on('console', (message) => {
      workerLogs.push(`${message.type()}: ${message.text()}`);
    });
  });
});

afterAll(async () => {
  await context?.close();
  await debugServer?.stop();
  await new Promise<void>((resolveServer, reject) =>
    modelServer?.close((error) => (error ? reject(error) : resolveServer()))
  );
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('REQ-OBS-001 Chrome debug hub E2E', () => {
  it('streams real Agent execution to an external authenticated hub', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      async ({ model }) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          'tinyai:v2:config': {
            approval: 'auto',
            language: 'en',
            theme: 'light',
            zoom: 100,
            connection: 'debug-e2e',
            model: 'debug-model',
            connections: [
              {
                id: 'debug-e2e',
                label: 'Debug E2E',
                'base-url': model,
                'api-key': 'e2e-key',
                models: ['debug-model'],
              },
            ],
          },
        });
      },
      { model: modelUrl }
    );

    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('#kernel-input');
    const targetTab = await page.evaluate(async () => {
      const current = await chrome.windows.getCurrent();
      const tab = await chrome.tabs.create({
        windowId: current.id,
        url: 'about:blank',
        active: true,
      });
      return String(tab.id);
    });
    await page.click('#kernel-tabs');
    await page.waitForSelector('#kernel-tab-menu:not([hidden])');
    await page.click(`[data-kernel-tab="${targetTab}"]`);
    await page.waitForFunction(
      (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
      targetTab
    );
    await page.click('#kernel-settings');
    await page.click('[data-page-action="debug-service"]');
    await page.waitForSelector('#kernel-debug-endpoint');
    await page.fill('#kernel-debug-endpoint', debugUrl);
    await page.fill('#kernel-debug-token', debugToken);
    await page.check('#kernel-debug-enabled');
    await page.click('[data-page-action="debug-test"]');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#kernel-page-layer')
          ?.textContent?.includes('Connection OK')
    );
    await page.click('[data-page-action="debug-save"]');
    try {
      await page.waitForFunction(
        () =>
          document
            .querySelector('#kernel-page-layer')
            ?.textContent?.includes('Saved and enabled'),
        undefined,
        { timeout: 30_000 }
      );
    } catch (cause) {
      throw new Error(
        `Debug settings did not apply: body=${JSON.stringify(
          await page.textContent('body')
        )}; errors=${JSON.stringify(errors)}; logs=${JSON.stringify(workerLogs)}`,
        { cause }
      );
    }
    await page.click('[data-page-action="back-runtime"]');
    await page.click('[data-page-action="back"]');
    await page.fill('#kernel-input', 'emit debug events');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'Debug trace complete'
        ),
      undefined,
      { timeout: 30_000 }
    );

    const session = await waitFor(async () => {
      const response = await fetch(`${debugUrl}/v1/sessions`, {
        headers: { Authorization: `Bearer ${debugToken}` },
      });
      const payload = (await response.json()) as {
        sessions?: Array<{ sessionId: string; eventCount: number }>;
      };
      return payload.sessions?.find((item) => item.eventCount >= 4);
    }).catch(async (error) => {
      throw new Error(
        `${error.message}; ingestCalls=${debugIngestCalls}; hub=${JSON.stringify(
          hub.listSessions()
        )}; body=${JSON.stringify(await page.textContent('body'))}; errors=${JSON.stringify(errors)}; logs=${JSON.stringify(workerLogs)}`
      );
    });
    expect(session).toBeDefined();
    const eventsResponse = await fetch(
      `${debugUrl}/v1/sessions/${encodeURIComponent(session!.sessionId)}/events?limit=200`,
      { headers: { Authorization: `Bearer ${debugToken}` } }
    );
    const events = (await eventsResponse.json()) as {
      events: Array<{ kind: string; visibility?: string; payload?: unknown }>;
      nextCursor: string;
    };
    expect(events.events.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['user', 'reasoning', 'tool', 'assistant'])
    );
    expect(
      events.events.find((event) => event.kind === 'reasoning')
    ).toMatchObject({
      visibility: 'displayed-reasoning',
    });
    expect(events.nextCursor).toEqual(expect.any(String));
    expect(errors).toEqual([]);
    await page.close();
  });
});

async function waitFor<T>(
  load: () => Promise<T | undefined>,
  timeoutMs = 15_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error('Timed out waiting for Debug Hub events');
}

function chromeExecutable(): string {
  const candidates = [
    process.env.CHROME_PATH,
    join(
      homedir(),
      'Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
    ),
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter((value): value is string => Boolean(value));
  const found = candidates.find(existsSync);
  if (!found) throw new Error('No Chrome executable found; set CHROME_PATH');
  return found;
}
