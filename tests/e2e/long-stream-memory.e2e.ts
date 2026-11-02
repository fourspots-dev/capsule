import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let modelServer: Server;
let modelUrl: string;
let context: BrowserContext;
let userDataDir: string;

beforeAll(async () => {
  modelServer = createServer((request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on('end', () => {
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      for (let index = 0; index < 2_000; index += 1) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  reasoning_content: 't'.repeat(100),
                  content: 'w'.repeat(100),
                },
                finish_reason: null,
              },
            ],
          })}\n\n`
        );
      }
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: 'LONG_STREAM_COMPLETE' },
              finish_reason: 'stop',
            },
          ],
        })}\n\n`
      );
      response.write('data: [DONE]\n\n');
      response.end();
    });
  });
  await new Promise<void>((resolveServer) =>
    modelServer.listen(0, '127.0.0.1', () => resolveServer())
  );
  const address = modelServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('No model server address');
  }
  modelUrl = `http://127.0.0.1:${address.port}/v1`;
  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-long-stream-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    executablePath: chromeExecutable(),
    args: [
      `--disable-extensions-except=${resolve('extension')}`,
      `--load-extension=${resolve('extension')}`,
      '--no-first-run',
      '--js-flags=--expose-gc',
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
});

afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolveServer, reject) =>
    modelServer?.close((error) => (error ? reject(error) : resolveServer()))
  );
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('REQ-PERF-001 long Chrome stream memory', () => {
  it('completes thousands of deltas with bounded renderer growth', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async ({ model }) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        'tinyai:v2:config': {
          approval: 'auto',
          language: 'en',
          theme: 'light',
          zoom: 100,
          connection: 'stream-e2e',
          model: 'stream-model',
          connections: [
            {
              id: 'stream-e2e',
              label: 'Stream E2E',
              'base-url': model,
              'api-key': 'e2e-key',
              models: ['stream-model'],
            },
          ],
        },
      });
    }, { model: modelUrl });

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
    const before = await heapSize(page);
    await page.fill('#kernel-input', 'run long stream');
    await page.click('#kernel-send');
    try {
      await page.waitForFunction(
        () =>
          document.documentElement.dataset.tinyaiCanSend === 'true' &&
          document
            .querySelector('#kernel-rows')
            ?.textContent?.includes('display truncated'),
        undefined,
        { timeout: 30_000 }
      );
    } catch (cause) {
      throw new Error(
        `Long stream did not complete: body=${JSON.stringify(
          (await page.textContent('body'))?.slice(-4_000)
        )}; heap=${await heapSize(page)}; errors=${JSON.stringify(errors)}`,
        { cause }
      );
    }
    await page.waitForTimeout(500);
    await page.evaluate(() => (window as typeof window & { gc?: () => void }).gc?.());
    const after = await heapSize(page);
    process.stdout.write(
      `REQ-PERF-001 long-stream heap growth: ${Math.round(
        (after - before) / (1024 * 1024)
      )} MB\n`
    );
    expect(after - before).toBeLessThan(384 * 1024 * 1024);
    expect(await page.locator('#kernel-rows').textContent()).toContain(
      'display truncated'
    );
    expect(errors).toEqual([]);
    await page.close();
  });
});

async function heapSize(page: import('playwright-core').Page): Promise<number> {
  return page.evaluate(
    () =>
      (
        performance as Performance & {
          memory?: { usedJSHeapSize: number };
        }
      ).memory?.usedJSHeapSize ?? 0
  );
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
