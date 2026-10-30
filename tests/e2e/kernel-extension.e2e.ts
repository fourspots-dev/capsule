import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let server: Server;
let baseUrl: string;
let context: BrowserContext;
let userDataDir: string;
let modelCalls = 0;
let fixtureCalls = 0;
let detachedStarted = false;
const backgroundLogs: string[] = [];
const browserPromptCalls = new Map<string, number>();
const subagentPromptCalls = new Map<string, number>();
const handoffPromptCalls = new Map<string, number>();

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/page') {
      fixtureCalls += 1;
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end(
        '<!doctype html><html><head><title>E2E Fixture</title></head><body><h1>Browser fixture ready</h1><button>Continue</button></body></html>'
      );
      return;
    }
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      modelCalls += 1;
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string }> };
      const userText =
        [...(parsed.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ??
        '';
      if (userText.includes('detached task')) {
        detachedStarted = true;
        setTimeout(() => {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: { content: 'Detached task completed' },
                  finish_reason: 'stop',
                },
              ],
            })}\n\n`
          );
          response.write('data: [DONE]\n\n');
          response.end();
        }, 800);
        return;
      }
      if (userText.includes('child-only instruction')) {
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { content: 'child-only answer' },
                finish_reason: 'stop',
              },
            ],
          })}\n\n`
        );
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      if (userText.includes('subagent smoke')) {
        const count = (subagentPromptCalls.get(userText) ?? 0) + 1;
        subagentPromptCalls.set(userText, count);
        if (count === 1) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_spawn',
                        function: {
                          name: 'spawn_agent',
                          arguments: JSON.stringify({
                            profile: 'general',
                            brief: 'child-only instruction',
                            contextMode: 'fresh',
                            executionMode: 'foreground',
                          }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`
          );
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
      }
      if (userText.includes('browser tool smoke')) {
        const count = (browserPromptCalls.get(userText) ?? 0) + 1;
        browserPromptCalls.set(userText, count);
        if (count === 1) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_navigate',
                        function: {
                          name: 'navigate',
                          arguments: JSON.stringify({ url: `${baseUrl.replace(/\/v1$/, '')}/page` }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`
          );
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
      }
      if (userText.includes('handoff smoke')) {
        const count = (handoffPromptCalls.get(userText) ?? 0) + 1;
        handoffPromptCalls.set(userText, count);
        if (count === 1) {
          response.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
          });
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_handoff',
                        function: {
                          name: 'await_user_action',
                          arguments: JSON.stringify({ reason: 'Complete the test login' }),
                        },
                      },
                    ],
                  },
                  finish_reason: 'tool_calls',
                },
              ],
            })}\n\n`
          );
          response.write('data: [DONE]\n\n');
          response.end();
          return;
        }
      }
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      response.write(
        `data: ${JSON.stringify({
          choices: [
            {
              delta: { content: `E2E received: ${userText}` },
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
    server.listen(0, '127.0.0.1', () => resolveServer())
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No model server address');
  baseUrl = `http://127.0.0.1:${address.port}/v1`;

  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-e2e-'));
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
    worker.on('console', (message) => backgroundLogs.push(`console:${message.text()}`));
    worker.on('close', () => backgroundLogs.push('worker:close'));
  });
});

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

afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolveServer, reject) =>
    server?.close((error) => (error ? reject(error) : resolveServer()))
  );
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('kernel extension E2E', () => {
  it('runs Command -> background runtime -> SSE -> Projection through Chrome', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      async ({ modelUrl }) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          'tinyai:v2:config': {
            approval: 'auto',
            language: 'en',
            theme: 'light',
            zoom: 100,
            connection: 'e2e',
            model: 'e2e-model',
            connections: [
              {
                id: 'e2e',
                label: 'E2E',
                'base-url': modelUrl,
                'api-key': 'e2e-key',
                models: ['e2e-model'],
              },
            ],
          },
        });
      },
      { modelUrl: baseUrl }
    );

    const page = await context.newPage();
    await page.setViewportSize({ width: 420, height: 900 });
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('#kernel-input');
    const layout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      sendVisible: Boolean(
        document.querySelector('#kernel-send')?.getBoundingClientRect().bottom
      ),
    }));
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.viewport + 1);
    expect(layout.sendVisible).toBe(true);
    await page.click('#kernel-settings');
    await page.waitForSelector('#kernel-page-layer');
    const settingsBox = await page.locator('#kernel-page-layer').boundingBox();
    expect(settingsBox?.width ?? 0).toBe(420);
    expect(settingsBox?.height ?? 0).toBe(900);
    expect(await page.locator('.wb-settings-title').textContent()).toBe('Settings');
    await page.click('[data-page-action="zoom"][data-delta="10"]');
    await page.waitForFunction(() =>
      document.querySelector('.wb-set-stepper-value')?.textContent?.includes('110%')
    );
    await page.click('[data-page-action="zoom"][data-delta="-10"]');
    await page.waitForFunction(() =>
      document.querySelector('.wb-set-stepper-value')?.textContent?.includes('100%')
    );
    await page.click('[data-page-action="theme"]');
    await page.waitForFunction(() => document.querySelector('[data-page-action="theme"]')?.textContent?.includes('Dark mode'));
    await page.click('[data-page-action="theme"]');
    await page.waitForFunction(() => document.querySelector('[data-page-action="theme"]')?.textContent?.includes('System'));
    await page.click('[data-page-action="theme"]');
    await page.waitForFunction(() => document.querySelector('[data-page-action="theme"]')?.textContent?.includes('Light mode'));
    await page.selectOption('#kernel-page-language', 'zh');
    await page.waitForFunction(() => document.querySelector('.wb-settings-title')?.textContent === '设置');
    await page.selectOption('#kernel-page-language', 'en');
    await page.waitForFunction(() => document.querySelector('.wb-settings-title')?.textContent === 'Settings');
    await page.screenshot({ path: resolve('docs/settings.png'), fullPage: false });
    await page.click('[data-page-action="connections"]');
    await page.waitForSelector('.wb-conn-card');
    expect(await page.locator('.wb-settings-title').textContent()).toBe('Connections');
    await page.screenshot({ path: resolve('docs/connections.png'), fullPage: false });
    await page.click('[data-page-action="conn-edit"]');
    await page.waitForSelector('#kernel-connection-form');
    await page.screenshot({ path: resolve('docs/connection-edit.png'), fullPage: false });
    await page.click('[data-page-action="conn-cancel"]');
    await page.click('[data-page-action="back-connections"]');
    await page.waitForSelector('[data-page-action="connections"]');
    await page.click('[data-page-action="back"]');
    await page.waitForSelector('#kernel-page-layer', { state: 'detached' });
    await page.screenshot({ path: resolve('docs/restored-empty.png'), fullPage: false });
    const disabledSend = await page.locator('#kernel-send').evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        disabled: (element as HTMLButtonElement).disabled,
        opacity: style.opacity,
        background: style.backgroundColor,
      };
    });
    expect(disabledSend.disabled).toBe(true);
    expect(disabledSend.opacity).toBe('0.3');
    expect(disabledSend.background).not.toBe('rgba(0, 0, 0, 0)');
    await page.setViewportSize({ width: 390, height: 740 });
    const mobileLayout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(mobileLayout.scrollWidth).toBeLessThanOrEqual(mobileLayout.viewport + 1);
    await page.screenshot({ path: resolve('docs/restored-empty-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 420, height: 900 });
    const offscreenDeadline = Date.now() + 5_000;
    let offscreenCount = 0;
    while (offscreenCount === 0 && Date.now() < offscreenDeadline) {
      offscreenCount = await worker.evaluate(
        async () =>
          (
            await chrome.runtime.getContexts({
              contextTypes: ['OFFSCREEN_DOCUMENT'],
            })
          ).length
      );
      if (offscreenCount === 0) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(offscreenCount).toBeGreaterThan(0);
    await page.fill('#kernel-input', 'extension smoke');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: extension smoke'),
      undefined,
      { timeout: 30_000 }
    );

    expect(pageErrors).toEqual([]);
    expect(modelCalls).toBe(1);
    expect(await page.locator('.wb-assistant').count()).toBeGreaterThan(0);
    await page.screenshot({ path: resolve('docs/restored-chat.png'), fullPage: false });
    await page.click('#kernel-tabs');
    await page.waitForSelector('#kernel-tab-menu:not([hidden])');
    expect(await page.locator('#kernel-tab-menu [data-kernel-tab]').count()).toBeGreaterThan(0);
    await page.click('#kernel-slash');
    await page.waitForSelector('#kernel-command-menu:not([hidden])');
    await page.click('#kernel-slash');

    await page.fill('#kernel-input', 'browser tool smoke');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: browser tool smoke'),
      undefined,
      { timeout: 30_000 }
    );
    expect(fixtureCalls).toBe(1);
    expect(modelCalls).toBe(3);
    expect(await page.locator('.kernel-tool-step', { hasText: 'Open page' }).count()).toBe(1);
    expect(pageErrors).toEqual([]);

    await page.fill('#kernel-input', 'subagent smoke');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'E2E received: subagent smoke'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(modelCalls).toBe(6);
    expect(await page.locator('.kernel-tool-step', { hasText: 'Start subagent' }).count()).toBe(1);
    expect(await page.locator('.kernel-child', { hasText: 'general' }).count()).toBe(1);
    expect(await page.locator('.kernel-child-open').count()).toBe(1);
    await page.screenshot({ path: resolve('docs/restored-subagent.png'), fullPage: false });
    await page.click('.kernel-child-open');
    await page.waitForFunction(() =>
      document.querySelector('#kernel-rows')?.textContent?.includes('child-only answer')
    );
    await page.click('#kernel-history');
    await page.waitForSelector('#kernel-page-layer');
    expect(await page.locator('.wb-settings-title').textContent()).toBe('Chat history');
    await page.screenshot({ path: resolve('docs/restored-history.png'), fullPage: false });
    const parentHistory = page.locator('.wb-history-main', { hasText: 'extension smoke' });
    expect(await parentHistory.count()).toBeGreaterThan(0);
    await parentHistory.first().click();
    await page.waitForFunction(() =>
      document.querySelector('#kernel-rows')?.textContent?.includes('subagent smoke')
    );
    expect(pageErrors).toEqual([]);

    await page.click('#kernel-slash');
    await page.waitForSelector('#kernel-command-menu:not([hidden])');
    await page.click('#kernel-mode');
    await page.waitForFunction(() => document.querySelector('#kernel-mode')?.textContent?.includes('Exit plan'));
    await page.click('#kernel-approve-plan');
    await page.waitForFunction(() => document.querySelector('#kernel-mode')?.textContent?.includes('Plan'));
    expect(pageErrors).toEqual([]);

    await page.fill('#kernel-input', 'detached task');
    await page.click('#kernel-send');
    await page.waitForSelector('.kernel-activity.is-running');
    const deadline = Date.now() + 5_000;
    while (!detachedStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(detachedStarted).toBe(true);
    await page.close();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const liveWorkersAfterClose = context.serviceWorkers().length;
    const persistedSnapshots = await worker.evaluate(async () =>
      Object.entries(await chrome.storage.local.get(null))
        .filter(([key]) => key.startsWith('tinyai:session:v1:'))
        .map(([, value]) => value as { rows?: Array<{ text?: string }> })
    );
    expect(persistedSnapshots.length).toBeGreaterThan(0);
    expect(
      persistedSnapshots.some((snapshot) =>
        snapshot.rows?.some((row) => row.text?.includes('Detached task completed'))
      )
    ).toBe(true);

    const reopened = await context.newPage();
    const reopenErrors: string[] = [];
    reopened.on('pageerror', (error) => reopenErrors.push(error.message));
    await reopened.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await reopened.waitForSelector('#kernel-input');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const gatewaySessions = await reopened.evaluate(
      () =>
        new Promise<any>((resolve) => {
          const port = chrome.runtime.connect({ name: 'tinyai-runtime-v1' });
          port.onMessage.addListener((message) => {
            if (message.type === 'response' && message.requestId === 'debug-list') {
              resolve(message.data);
              port.disconnect();
            }
          });
          port.postMessage({ type: 'list_sessions', requestId: 'debug-list' });
          setTimeout(() => resolve({ timeout: true }), 5_000);
        })
    );
    expect(Array.isArray(gatewaySessions)).toBe(true);
    expect(gatewaySessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: expect.any(String),
          taskStatus: 'completed',
        }),
      ])
    );
    const reopenedText = await reopened.textContent('body');
    if (!reopenedText?.includes('Detached task completed')) {
      throw new Error(
        `Detached projection missing after reopen: workers=${liveWorkersAfterClose} sessions=${JSON.stringify(gatewaySessions)} logs=${JSON.stringify(backgroundLogs)} ${reopenedText}`
      );
    }
    expect(reopenErrors).toEqual([]);
    expect(modelCalls).toBe(7);

    await reopened.fill('#kernel-input', 'handoff smoke');
    await reopened.click('#kernel-send');
    await reopened.waitForSelector('.kernel-handoff');
    await reopened.click('.kernel-handoff [data-decision="continue"]');
    await reopened.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'E2E received: handoff smoke'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(modelCalls).toBe(9);
    expect(reopenErrors).toEqual([]);

    await reopened.setInputFiles('#kernel-file-input', {
      name: 'notes.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('attachment evidence'),
    });
    await reopened.waitForFunction(() =>
      document.querySelector('#kernel-attachments')?.textContent?.includes('notes.txt')
    );
    await reopened.fill('#kernel-input', 'attachment smoke');
    await reopened.click('#kernel-send');
    await reopened.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'E2E received: attachment smoke'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(modelCalls).toBe(10);
  });
});
