import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let context: BrowserContext;
let userDataDir: string;

beforeAll(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-ui-contract-'));
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
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('REQ-UI-001 Side Panel UI Contract', () => {
  it('uses canonical settings rows, forms and subpage navigation at supported widths', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        'tinyai:v2:config': {
          approval: 'auto',
          language: 'en',
          theme: 'light',
          zoom: 100,
          connection: 'ui-contract',
          model: 'ui-contract-model',
          connections: [
            {
              id: 'ui-contract',
              label: 'UI Contract',
              'base-url': 'http://127.0.0.1:1/v1',
              'api-key': 'test-key',
              models: ['ui-contract-model'],
            },
          ],
        },
      });
    });

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
    await page.waitForSelector('#kernel-page-layer');
    expect(await page.locator('.wb-settings-title').textContent()).toBe('Settings');
    expect(await page.locator('[data-page-action="capabilities"]').count()).toBe(1);
    expect(await page.locator('[data-page-action="remote-actions"]').count()).toBe(1);

    const rowStyle = await page
      .locator('[data-page-action="capabilities"]')
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          border: style.borderTopWidth,
          background: style.backgroundColor,
          height: element.getBoundingClientRect().height,
        };
      });
    expect(rowStyle.border).toBe('0px');
    expect(rowStyle.background).toBe('rgba(0, 0, 0, 0)');
    expect(rowStyle.height).toBeGreaterThanOrEqual(48);

    await page.click('[data-page-action="capabilities"]');
    await page.waitForFunction(
      () =>
        document.querySelector('.wb-settings-title')?.textContent ===
        'Capabilities & evidence'
    );
    await page.click('[data-page-action="back-runtime"]');
    await page.waitForFunction(
      () => document.querySelector('.wb-settings-title')?.textContent === 'Settings'
    );

    await page.click('[data-page-action="remote-actions"]');
    await page.waitForSelector('#kernel-remote-endpoint');
    const remoteInput = await page
      .locator('#kernel-remote-endpoint')
      .evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          radius: style.borderRadius,
          background: style.backgroundColor,
          width: element.getBoundingClientRect().width,
        };
      });
    expect(remoteInput.radius).toBe('9px');
    expect(remoteInput.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(remoteInput.width).toBeGreaterThan(300);
    await page.click('[data-page-action="back-runtime"]');
    await page.waitForFunction(
      () => document.querySelector('.wb-settings-title')?.textContent === 'Settings'
    );

    await page.click('[data-page-action="debug-service"]');
    await page.waitForSelector('#kernel-debug-endpoint');
    expect(
      await page
        .locator('#kernel-debug-endpoint')
        .evaluate((element) => getComputedStyle(element).borderRadius)
    ).toBe('9px');
    await page.click('[data-page-action="back-runtime"]');
    await page.waitForFunction(
      () => document.querySelector('.wb-settings-title')?.textContent === 'Settings'
    );

    await page.click('[data-page-action="connections"]');
    await page.waitForSelector('[data-page-action="conn-edit"]');
    await page.click('[data-page-action="conn-edit"]');
    await page.waitForSelector('#kernel-connection-form');
    expect(
      await page
        .locator('#kernel-page-conn-base')
        .evaluate((element) => getComputedStyle(element).borderRadius)
    ).toBe('9px');
    await page.click('[data-page-action="back-connections"]');
    await page.waitForFunction(
      () => document.querySelector('.wb-settings-title')?.textContent === 'Settings'
    );
    await page.screenshot({
      path: resolve('dist/ui-contract-settings-420.png'),
      fullPage: false,
    });

    await page.click('[data-page-action="back"]');
    await page.setViewportSize({ width: 320, height: 700 });
    await page.click('#kernel-settings');
    await page.waitForSelector('#kernel-page-layer');
    const narrow = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      row: document
        .querySelector('[data-page-action="remote-actions"]')
        ?.getBoundingClientRect(),
    }));
    expect(narrow.scrollWidth).toBeLessThanOrEqual(narrow.viewport + 1);
    expect(narrow.row?.width ?? 0).toBeGreaterThan(250);
    await page.screenshot({
      path: resolve('dist/ui-contract-settings-320.png'),
      fullPage: false,
    });
    expect(errors).toEqual([]);
    await page.close();
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
