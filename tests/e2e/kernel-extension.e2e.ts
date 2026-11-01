import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
const groupWorkspacePromptCalls = new Map<string, number>();
const remoteActionPromptCalls = new Map<string, number>();
const capturedToolRequests: string[][] = [];
let remoteActionCalls = 0;

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
    if (request.url === '/actions') {
      let body = '';
      request.on('data', (chunk) => {
        body += chunk;
      });
      request.on('end', () => {
        remoteActionCalls += 1;
        const parsed = JSON.parse(body) as {
          type?: string;
          actionId?: string;
        };
        response.writeHead(200, { 'Content-Type': 'application/json' });
        if (parsed.type === 'describe') {
          response.end(
            JSON.stringify({
              actions: [
                {
                  id: 'app.e2e.remote-check',
                  version: '1.0.0',
                  title: 'Remote E2E check',
                  description: 'Validate the remote Action bridge.',
                  inputSchema: { type: 'object', properties: {} },
                  outputSchema: { type: 'object', properties: {} },
                  effects: ['read'],
                  risk: 'read',
                  workspaceBinding: 'remote',
                  probe: { state: 'available' },
                },
              ],
            })
          );
          return;
        }
        response.end(
          JSON.stringify({
            result: {
              status:
                parsed.type === 'invoke' &&
                parsed.actionId === 'app.e2e.remote-check'
                  ? 'succeeded'
                  : 'failed',
              value: { remoteCheck: 'passed' },
            },
          })
        );
      });
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
      const parsed = JSON.parse(body) as {
        messages?: Array<{ role: string; content: string }>;
        tools?: Array<{ function?: { name?: string } }>;
      };
      capturedToolRequests.push(
        (parsed.tools ?? [])
          .map((tool) => tool.function?.name)
          .filter((name): name is string => Boolean(name))
      );
      const userText =
        [...(parsed.messages ?? [])].reverse().find((message) => message.role === 'user')?.content ??
        '';
      if (userText.includes('remote action smoke')) {
        const count = (remoteActionPromptCalls.get(userText) ?? 0) + 1;
        remoteActionPromptCalls.set(userText, count);
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
                        id: 'call_remote_check',
                        function: {
                          name: 'action_app_e2e_remote_check',
                          arguments: '{}',
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
      if (userText.includes('group workspace smoke')) {
        const count = (groupWorkspacePromptCalls.get(userText) ?? 0) + 1;
        groupWorkspacePromptCalls.set(userText, count);
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
                        id: 'call_group_tab',
                        function: {
                          name: 'new_tab',
                          arguments: JSON.stringify({
                            url: `${baseUrl.replace(/\/v1$/, '')}/page`,
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
              delta: {
                reasoning_content: 'Check the request and return the committed result.',
                content: `E2E received: ${userText}`,
              },
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
                models: ['e2e-model', 'e2e-model-alt'],
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
    const initialTab = await page.evaluate(async () => {
      const current = await chrome.windows.getCurrent();
      const tab = await chrome.tabs.create({
        windowId: current.id,
        url: 'about:blank',
        active: true,
      });
      await chrome.tabs.update(tab.id!, { active: true });
      return String(tab.id);
    });
    await page.click('#kernel-tabs');
    await page.waitForSelector('#kernel-tab-menu:not([hidden])');
    await page.click(`[data-kernel-tab="${initialTab}"]`);
    await page.waitForFunction(
      (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
      initialTab
    );
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
    await page.click('[data-page-action="reasoning"]');
    await page.waitForFunction(() =>
      document.querySelector('[data-page-action="reasoning"]')?.textContent?.includes('Hidden')
    );
    await page.click('[data-page-action="reasoning"]');
    await page.waitForFunction(() =>
      document.querySelector('[data-page-action="reasoning"]')?.textContent?.includes('Show')
    );
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
    await page.click('#kernel-model');
    await page.waitForSelector('#kernel-model-menu:not([hidden])');
    expect(
      await page
        .locator('[data-kernel-model="e2e-model"]')
        .getAttribute('aria-pressed')
    ).toBe('true');
    await page.click('[data-kernel-model="e2e-model-alt"]');
    await page.waitForFunction(
      () =>
        document.querySelector('[data-kernel-model="e2e-model-alt"]')?.getAttribute('aria-pressed') ===
          'true' &&
        document.querySelector('#kernel-model-label')?.textContent === 'e2e-model-alt'
    );
    expect(
      await page
        .locator('[data-kernel-model="e2e-model-alt"] .wb-pop-check')
        .count()
    ).toBe(1);
    expect(
      await page.evaluate(async () => {
        const stored = await chrome.storage.local.get('tinyai:v2:config');
        return (stored['tinyai:v2:config'] as { model?: string }).model;
      })
    ).toBe('e2e-model-alt');
    await page.screenshot({ path: resolve('docs/model-switched.png'), fullPage: false });
    await page.locator('body').click({ position: { x: 8, y: 500 } });
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
    await page.setViewportSize({ width: 320, height: 700 });
    const narrowLayout = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(narrowLayout.scrollWidth).toBeLessThanOrEqual(narrowLayout.viewport + 1);
    await page.screenshot({ path: resolve('docs/restored-empty-320.png'), fullPage: false });
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
    const modelSwitchState = await page.evaluate(() => ({
      sendDisabled: document.querySelector<HTMLButtonElement>('#kernel-send')?.disabled,
      status: document.querySelector('#kernel-status')?.textContent ?? '',
      error: document.querySelector<HTMLElement>('#kernel-status')?.dataset.error,
      activated: document.documentElement.dataset.tinyaiActivated,
      canSend: document.documentElement.dataset.tinyaiCanSend,
      input: document.querySelector<HTMLTextAreaElement>('#kernel-input')?.value,
    }));
    if (modelSwitchState.sendDisabled) {
      throw new Error(`Model switch did not restore input: ${JSON.stringify(modelSwitchState)}`);
    }
    await page.click('#kernel-send');
    await page.waitForFunction(
      () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: extension smoke'),
      undefined,
      { timeout: 30_000 }
    );

    expect(pageErrors).toEqual([]);
    expect(modelCalls).toBe(1);
    expect(await page.locator('.wb-assistant').count()).toBeGreaterThan(0);
    const completedWork = page.locator('.kernel-work').first();
    expect(await completedWork.locator('.kernel-work-summary').textContent()).toContain('Worked');
    expect(await completedWork.getAttribute('open')).toBeNull();
    await completedWork.locator('.kernel-work-summary').click();
    const reasoning = completedWork.locator('.kernel-reasoning');
    expect(await reasoning.count()).toBe(1);
    expect(await reasoning.getAttribute('open')).toBeNull();
    await reasoning.locator('summary').click();
    expect(await reasoning.locator('.kernel-reasoning-body').textContent()).toContain(
      'Check the request'
    );
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
    const subagentTurn = page.locator('.kernel-turn', { hasText: 'subagent smoke' });
    await subagentTurn.locator('.kernel-work-summary').click();
    expect(await subagentTurn.locator('.kernel-tool-step').getAttribute('open')).toBeNull();
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
    await page.waitForSelector('.kernel-child--completed', { state: 'attached' });
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
    await page.waitForSelector('#kernel-status:not([hidden])');
    await page.fill('#kernel-input', 'queued follow-up');
    await page.click('#kernel-send');
    await page.waitForFunction(() =>
      document.querySelector('#kernel-queue')?.textContent?.includes('1 message queued')
    );
    const deadline = Date.now() + 5_000;
    while (!detachedStarted && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(detachedStarted).toBe(true);
    await page.screenshot({ path: resolve('docs/restored-running.png'), fullPage: false });
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
    await reopened.evaluate(
      (tabId) => chrome.tabs.update(Number(tabId), { active: true }),
      initialTab
    );
    await reopened.click('#kernel-tabs');
    await reopened.waitForSelector('#kernel-tab-menu:not([hidden])');
    await reopened.click(`[data-kernel-tab="${initialTab}"]`);
    await reopened.waitForFunction(
      (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
      initialTab
    );
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
    const tabSessionState = await reopened.evaluate(async () => ({
      activeTab: document.documentElement.dataset.tinyaiTabId,
      mapping: await chrome.storage.session.get('tinyai:tab-sessions:v1'),
    }));
    const reopenedText = await reopened.textContent('body');
    if (!reopenedText?.includes('Detached task completed')) {
      throw new Error(
        `Detached projection missing after reopen: workers=${liveWorkersAfterClose} sessions=${JSON.stringify(gatewaySessions)} tabState=${JSON.stringify(tabSessionState)} logs=${JSON.stringify(backgroundLogs)} ${reopenedText}`
      );
    }
    expect(reopenErrors).toEqual([]);
    expect(modelCalls).toBe(8);

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
    expect(modelCalls).toBe(10);
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
    expect(modelCalls).toBe(11);

    await reopened.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const port = chrome.runtime.connect({ name: 'tinyai-runtime-v1' });
          port.onMessage.addListener((message) => {
            if (message.type === 'response' && message.requestId === 'reload-existing') {
              port.disconnect();
              if (message.ok) resolve();
              else reject(new Error(message.error?.message ?? 'reload failed'));
            }
          });
          port.postMessage({ type: 'reload_runtime', requestId: 'reload-existing' });
        })
    );
    await reopened.reload();
    await reopened.waitForSelector('#kernel-input');
    await reopened.waitForFunction(
      () => document.querySelector('#kernel-rows')?.textContent?.includes('attachment smoke'),
      undefined,
      { timeout: 30_000 }
    );
    await reopened.fill('#kernel-input', 'after runtime reload');
    await reopened.click('#kernel-send');
    await reopened.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'E2E received: after runtime reload'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(modelCalls).toBe(12);
    expect(reopenErrors).toEqual([]);
    await reopened.screenshot({
      path: resolve('docs/restored-cold-reload.png'),
      fullPage: false,
    });
    const callsBeforeGroupWorkspace = modelCalls;
    await reopened.fill('#kernel-input', 'group workspace smoke');
    await reopened.click('#kernel-send');
    await reopened.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'E2E received: group workspace smoke'
        ),
      undefined,
      { timeout: 30_000 }
    );
    expect(modelCalls).toBe(callsBeforeGroupWorkspace + 2);
    await reopened.waitForFunction(
      async (tabId) => (await chrome.tabs.get(Number(tabId))).groupId >= 0,
      initialTab,
      { timeout: 10_000 }
    );
    const groupWorkspace = await reopened.evaluate(async (tabId) => {
      const initial = await chrome.tabs.get(Number(tabId));
      const openTabs = await chrome.tabs.query({ windowId: initial.windowId });
      const members = openTabs.filter((tab) => tab.groupId === initial.groupId);
      return {
        groupId: initial.groupId,
        members: members.map((tab) => ({
          id: String(tab.id),
          title: tab.title,
          url: tab.url,
          active: tab.active,
        })),
        uiTabId: document.documentElement.dataset.tinyaiTabId,
        toolText: [...document.querySelectorAll('.kernel-tool-step')]
          .map((node) => node.textContent?.trim())
          .filter(Boolean),
        allTabs: openTabs.map((tab) => ({
          id: tab.id,
          title: tab.title,
          groupId: tab.groupId,
        })),
      };
    }, initialTab);
    if (groupWorkspace.groupId < 0) {
      throw new Error(`Group workspace failed: ${JSON.stringify(groupWorkspace)}`);
    }
    expect(groupWorkspace.members.length).toBeGreaterThanOrEqual(2);
    expect(groupWorkspace.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: 'E2E Fixture' }),
      ])
    );
    expect(groupWorkspace.uiTabId).toBe(
      groupWorkspace.members.find((tab) => tab.active)?.id
    );
    await reopened.click('#kernel-tabs');
    await reopened.waitForSelector('#kernel-tab-menu:not([hidden])');
    await reopened.click(`[data-kernel-tab="${initialTab}"]`);
    await reopened.waitForFunction(
      () =>
        document.querySelector('#kernel-rows')?.textContent?.includes(
          'group workspace smoke'
        ),
      undefined,
      { timeout: 10_000 }
    );
    expect(await reopened.textContent('#kernel-workspace')).toContain(
      'Workspace · 2 tabs'
    );
    await reopened.click('#kernel-tabs');
    await reopened.waitForSelector('#kernel-tab-menu:not([hidden])');
    expect(await reopened.textContent('#kernel-tab-menu')).toContain('Current workspace');
    expect(await reopened.textContent('#kernel-tab-menu')).toContain(
      'Other independent tabs'
    );
    await reopened.locator('body').click({ position: { x: 8, y: 500 } });
    await reopened.screenshot({
      path: resolve('docs/group-workspace-tabs.png'),
      fullPage: false,
    });
  });

  it('keeps one conversation per tab and switches automatically', async () => {
    const tabDir = await mkdtemp(join(tmpdir(), 'tinyai-tab-sessions-e2e-'));
    const tabContext = await chromium.launchPersistentContext(tabDir, {
      headless: true,
      executablePath: chromeExecutable(),
      args: [
        `--disable-extensions-except=${resolve('extension')}`,
        `--load-extension=${resolve('extension')}`,
        '--no-first-run',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    try {
      let worker = tabContext.serviceWorkers()[0];
      if (!worker) worker = await tabContext.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await worker.evaluate(
        async ({ modelUrl }) => {
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

      const page = await tabContext.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.waitForSelector('#kernel-input');
      const tabA = await page.evaluate(async () => {
        const current = await chrome.windows.getCurrent();
        const tab = await chrome.tabs.create({
          windowId: current.id,
          url: 'about:blank',
          active: true,
        });
        await chrome.tabs.update(tab.id!, { active: true });
        return String(tab.id);
      });
      await page.click('#kernel-tabs');
      await page.waitForSelector('#kernel-tab-menu:not([hidden])');
      await page.click(`[data-kernel-tab="${tabA}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        tabA
      );
      const callsBefore = modelCalls;
      await page.fill('#kernel-input', 'tab A question');
      await page.click('#kernel-send');
      await page.waitForFunction(
        () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: tab A question'),
        undefined,
        { timeout: 30_000 }
      );

      const tabB = await page.evaluate(async () => {
        const current = await chrome.windows.getCurrent();
        const tab = await chrome.tabs.create({
          windowId: current.id,
          url: 'about:blank',
          active: true,
        });
        await chrome.tabs.update(tab.id!, { active: true });
        return String(tab.id);
      });
      await page.click('#kernel-tabs');
      await page.waitForSelector('#kernel-tab-menu:not([hidden])');
      await page.click(`[data-kernel-tab="${tabB}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        tabB
      );
      await page.waitForTimeout(1_000);
      const tabBDiagnostics = await page.evaluate(async (tabId) => {
        const tab = await chrome.tabs.get(Number(tabId));
        const activeTabs = await chrome.tabs.query({
          active: true,
          windowId: tab.windowId,
        });
        return {
          body: document.querySelector('#kernel-rows')?.textContent ?? '',
          status: document.querySelector('#kernel-status')?.textContent ?? '',
          activeTab: tab.active,
          windowId: tab.windowId,
          uiTabId: document.documentElement.dataset.tinyaiTabId,
          uiWindowId: document.documentElement.dataset.tinyaiWindowId,
          uiSessionId: document.documentElement.dataset.tinyaiSessionId,
          activeTabs: activeTabs.map((item) => ({
            id: item.id,
            url: item.url,
            active: item.active,
          })),
        };
      }, tabB);
      if (tabBDiagnostics.body.includes('tab A question')) {
        throw new Error(`Tab switch failed: ${JSON.stringify(tabBDiagnostics)}`);
      }
      await page.fill('#kernel-input', 'tab B question');
      await page.click('#kernel-send');
      await page.waitForFunction(
        () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: tab B question'),
        undefined,
        { timeout: 30_000 }
      );

      await page.click('#kernel-tabs');
      await page.waitForSelector('#kernel-tab-menu:not([hidden])');
      await page.click(`[data-kernel-tab="${tabA}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        tabA
      );
      await page.waitForFunction(
        () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: tab A question'),
        undefined,
        { timeout: 10_000 }
      );
      expect(await page.textContent('#kernel-rows')).not.toContain('tab B question');

      await page.click('#kernel-tabs');
      await page.waitForSelector('#kernel-tab-menu:not([hidden])');
      await page.click(`[data-kernel-tab="${tabB}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        tabB
      );
      await page.waitForFunction(
        () => document.querySelector('#kernel-rows')?.textContent?.includes('E2E received: tab B question'),
        undefined,
        { timeout: 10_000 }
      );
      expect(await page.textContent('#kernel-rows')).not.toContain('tab A question');
      expect(modelCalls).toBe(callsBefore + 2);
      expect(pageErrors).toEqual([]);
      await page.screenshot({ path: resolve('docs/tab-scoped-sessions.png'), fullPage: false });

      await page.evaluate(
        (tabId) => chrome.tabs.remove(Number(tabId)),
        tabB
      );
      await page.waitForTimeout(750);
      expect(await page.textContent('body')).not.toContain(
        'BROWSER_TAB_NOT_FOUND'
      );

      await page.click('#kernel-settings');
      await page.waitForSelector('[data-page-action="clear-history"]');
      page.once('dialog', (dialog) => dialog.accept());
      await page.click('[data-page-action="clear-history"]');
      await page.waitForSelector('#kernel-page-layer', { state: 'detached' });
      await page.waitForFunction(
        () => !document.querySelector('#kernel-rows')?.textContent?.includes('tab B question')
      );
      await page.click('#kernel-history');
      await page.waitForSelector('#kernel-page-layer');
      const historyText = await page.textContent('#kernel-page-layer');
      expect(historyText).not.toContain('tab A question');
      expect(historyText).not.toContain('tab B question');
    } finally {
      await tabContext.close();
      await rm(tabDir, { recursive: true, force: true });
    }
  });

  it('restores an imported legacy session and continues it after migration', async () => {
    const legacyId = '5db19410-a409-4da1-9d21-8ae09c1e10ed';
    const legacyDir = await mkdtemp(join(tmpdir(), 'tinyai-legacy-e2e-'));
    const legacyContext = await chromium.launchPersistentContext(legacyDir, {
      headless: true,
      executablePath: chromeExecutable(),
      args: [
        `--disable-extensions-except=${resolve('extension')}`,
        `--load-extension=${resolve('extension')}`,
        '--no-first-run',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    try {
      let worker = legacyContext.serviceWorkers()[0];
      if (!worker) worker = await legacyContext.waitForEvent('serviceworker');
      const extensionId = new URL(worker.url()).host;
      await worker.evaluate(
        async ({ modelUrl, legacyId }) => {
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
            'clj-agent-sessions': {
              active: legacyId,
              sessions: [
                {
                  id: legacyId,
                  title: 'Legacy restored chat',
                  updated: 10,
                  messages: [{ role: 'user', content: 'legacy restored question' }],
                  timeline: [{ kind: 'user', text: 'legacy restored question' }],
                },
              ],
            },
          });
        },
        { modelUrl: baseUrl, legacyId }
      );

      const page = await legacyContext.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.waitForSelector('#kernel-input');
      const activeTab = await page.evaluate(async () => {
        const current = await chrome.windows.getCurrent();
        const tab = await chrome.tabs.create({
          windowId: current.id,
          url: 'about:blank',
          active: true,
        });
        await chrome.tabs.update(tab.id!, { active: true });
        return String(tab.id);
      });
      await page.click('#kernel-tabs');
      await page.waitForSelector('#kernel-tab-menu:not([hidden])');
      await page.click(`[data-kernel-tab="${activeTab}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        activeTab
      );
      await page.click('#kernel-history');
      await page.waitForSelector('#kernel-page-layer');
      await page
        .locator('.wb-history-main', { hasText: 'legacy restored question' })
        .click();
      await page.waitForFunction(
        () =>
          document.querySelector('#kernel-rows')?.textContent?.includes(
            'legacy restored question'
          ),
        undefined,
        { timeout: 30_000 }
      );
      expect(await page.textContent('body')).not.toContain('Session not found');
      const callsBeforeFollowUp = modelCalls;
      await page.fill('#kernel-input', 'legacy follow-up');
      await page.click('#kernel-send');
      await page.waitForFunction(
        () =>
          document.querySelector('#kernel-rows')?.textContent?.includes(
            'E2E received: legacy follow-up'
          ),
        undefined,
        { timeout: 30_000 }
      );
      expect(modelCalls).toBe(callsBeforeFollowUp + 1);
      expect(pageErrors).toEqual([]);
      await page.screenshot({ path: resolve('docs/restored-legacy.png'), fullPage: false });
    } finally {
      await legacyContext.close();
      await rm(legacyDir, { recursive: true, force: true });
    }
  });

  it('reports missing model configuration instead of dropping the runtime port', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => chrome.storage.local.clear());

    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const port = chrome.runtime.connect({ name: 'tinyai-runtime-v1' });
          port.onMessage.addListener((message) => {
            if (message.type === 'response' && message.requestId === 'reload-empty') {
              port.disconnect();
              if (message.ok) resolve();
              else reject(new Error(message.error?.message ?? 'reload failed'));
            }
          });
          port.postMessage({ type: 'reload_runtime', requestId: 'reload-empty' });
        })
    );
    await page.reload();
    await page.waitForTimeout(1_500);
    const debugStatus = await page.evaluate(() => ({
      hidden: document.querySelector<HTMLElement>('#kernel-status')?.hidden,
      text: document.querySelector('#kernel-status')?.textContent ?? '',
      body: document.body.innerText,
    }));
    expect(debugStatus.text).toContain('No model configuration was found');
    const status = debugStatus.text;
    expect(status).not.toContain('disconnected');
    expect(pageErrors).toEqual([]);
    await page.close();
  });

  it('configures Remote Actions, exposes evidence state and transfers a Capsule', async () => {
    const remoteDir = await mkdtemp(join(tmpdir(), 'tinyai-chrome-remote-e2e-'));
    const remoteContext = await chromium.launchPersistentContext(remoteDir, {
      headless: true,
      executablePath: chromeExecutable(),
      args: [
        `--disable-extensions-except=${resolve('extension')}`,
        `--load-extension=${resolve('extension')}`,
        '--no-first-run',
      ],
      ignoreDefaultArgs: ['--disable-extensions'],
    });
    try {
      let worker = remoteContext.serviceWorkers()[0];
      if (!worker) worker = await remoteContext.waitForEvent('serviceworker');
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

      const page = await remoteContext.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      await page.waitForSelector('#kernel-input');
      const requestStart = capturedToolRequests.length;
      const initialTab = await page.evaluate(async () => {
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
      await page.click(`[data-kernel-tab="${initialTab}"]`);
      await page.waitForFunction(
        (tabId) => document.documentElement.dataset.tinyaiTabId === tabId,
        initialTab
      );

      await page.click('#kernel-settings');
      await page.waitForSelector('#kernel-remote-endpoint');
      await page.fill(
        '#kernel-remote-endpoint',
        `${baseUrl.replace(/\/v1$/, '')}/actions`
      );
      await page.fill('#kernel-remote-allowlist', 'app.e2e.remote-check');
      await page.click('[data-page-action="remote-save"]');
      try {
        await page.waitForFunction(
          () =>
            document
              .querySelector('#kernel-page-layer')
              ?.textContent?.includes('Remote E2E check'),
          undefined,
          { timeout: 30_000 }
        );
      } catch (cause) {
        throw new Error(
          `Remote Action board did not update: calls=${remoteActionCalls} body=${JSON.stringify(
            await page.textContent('body')
          )} errors=${JSON.stringify(pageErrors)}`,
          { cause }
        );
      }
      const boardText = await page.textContent('#kernel-page-layer');
      expect(boardText).toContain('Remote E2E check');
      expect(boardText).toContain('available');
      expect(boardText).toContain('current evidence');

      await page.click('[data-page-action="back"]');
      await page.fill('#kernel-input', 'remote action smoke');
      await page.click('#kernel-send');
      await page.waitForFunction(
        () =>
          document.querySelector('#kernel-rows')?.textContent?.includes(
            'remoteCheck'
          ),
        undefined,
        { timeout: 30_000 }
      );
      await page.waitForFunction(
        () =>
          document.querySelector('#kernel-rows')?.textContent?.includes(
            'E2E received: remote action smoke'
          ),
        undefined,
        { timeout: 30_000 }
      );
      expect(remoteActionCalls).toBeGreaterThanOrEqual(3);
      const requestedTools = capturedToolRequests
        .slice(requestStart)
        .flat();
      expect(requestedTools).toContain('action_app_e2e_remote_check');
      expect(requestedTools).not.toContain('exec');
      expect(requestedTools).not.toContain('job_start');

      await page.click('#kernel-settings');
      await page.waitForFunction(
        () =>
          document
            .querySelector('#kernel-page-layer')
            ?.textContent?.includes('Last call · completed'),
        undefined,
        { timeout: 30_000 }
      );
      await page.waitForSelector('[data-page-action="capsule-export"]');
      const downloadPromise = page.waitForEvent('download');
      await page.click('[data-page-action="capsule-export"]');
      const download = await downloadPromise;
      const capsulePath = join(remoteDir, 'workspace.capsule');
      await download.saveAs(capsulePath);
      expect((await readFile(capsulePath)).byteLength).toBeGreaterThan(100);

      page.once('dialog', (dialog) => void dialog.accept());
      await page.setInputFiles('#kernel-capsule-file', capsulePath);
      await page.waitForFunction(
        () =>
          !document.querySelector('#kernel-page-layer') &&
          document.documentElement.dataset.tinyaiActivated === 'true',
        undefined,
        { timeout: 30_000 }
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await remoteContext.close();
      await rm(remoteDir, { recursive: true, force: true });
    }
  });
});
