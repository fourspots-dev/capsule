import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let context: BrowserContext;
let userDataDir: string;
let server: ReturnType<typeof createServer>;
let baseUrl: string;

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

beforeAll(async () => {
  let calls = 0;
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      calls += 1;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      const event =
        calls === 1
          ? {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_navigate',
                        function: {
                          name: 'navigate',
                          arguments: '{"url":"https://example.com"}',
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            }
          : {
              choices: [
                {
                  delta: { content: 'Approved browser action completed' },
                  finish_reason: 'stop',
                },
              ],
            };
      void body;
      response.write(`data: ${JSON.stringify(event)}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No server address');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-approval-'));
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
});

afterAll(async () => {
  await context?.close();
  await new Promise<void>((done) => server?.close(() => done()));
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('approval E2E', () => {
  it('blocks a risky browser action until the user approves it', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      async ({ modelUrl }) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          'tinyai:v2:config': {
            approval: 'ask',
            connection: 'e2e',
            model: 'e2e',
            connections: [
              {
                id: 'e2e',
                'base-url': modelUrl,
                'api-key': 'test',
                models: ['e2e'],
              },
            ],
          },
        });
      },
      { modelUrl: baseUrl }
    );
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('#kernel-input');
    await page.fill('#kernel-input', 'run approved action');
    await page.click('#kernel-send');
    await page.waitForSelector('.kernel-approval');
    expect(await page.textContent('.kernel-approval')).toContain('Open page');
    await page.click('.kernel-approval [data-decision="allow"]');
    await page.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'Approved browser action completed'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(await page.locator('.kernel-tool-step', { hasText: 'Open page' }).count()).toBe(1);
  });
});
