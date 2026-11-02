import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchE2EChrome } from '../harness/chrome-e2e';

let server: Server;
let context: BrowserContext;
let userDataDir: string;
let modelUrl: string;
const toolResults: Array<{ name: string; content: string }> = [];
const isolationResults: string[] = [];
let isolationCalls = 0;

beforeAll(async () => {
  server = createServer((request, response) => {
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
        messages?: Array<{
          role: string;
          name?: string;
          content: string;
        }>;
      };
      const tools = (parsed.messages ?? []).filter(
        (message) => message.role === 'tool'
      );
      const latest = tools.at(-1);
      if (latest?.name) {
        toolResults.push({ name: latest.name, content: latest.content });
      }
      const userText =
        [...(parsed.messages ?? [])]
          .reverse()
          .find((message) => message.role === 'user')?.content ?? '';
      if (userText === 'workspace isolation check') {
        isolationCalls += 1;
        response.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        });
        if (isolationCalls === 1) {
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_isolation_list',
                        function: {
                          name: 'list_files',
                          arguments: '{"path":"","recursive":true}',
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
          isolationResults.push(latest?.content ?? '');
          response.write(
            `data: ${JSON.stringify({
              choices: [
                {
                  delta: { content: 'workspace isolation complete' },
                  finish_reason: 'stop',
                },
              ],
            })}\n\n`
          );
        }
        response.write('data: [DONE]\n\n');
        response.end();
        return;
      }
      const call =
        tools.length === 0
          ? {
              name: 'write_file',
              arguments: {
                path: 'apps/workspace-game.html',
                text: `<!doctype html><html><head><title>Workspace Game</title></head><body><main id="game">ready</main><script>window.gameReady = 42;</script></body></html>`,
              },
            }
          : tools.length === 1
            ? {
                name: 'open_workspace_file',
                arguments: {
                  path: 'apps/workspace-game.html',
                  intent: 'preview',
                },
              }
            : tools.length === 2
              ? {
                  name: 'verify_workspace_file',
                  arguments: {
                    path: 'apps/workspace-game.html',
                    assertions: [
                      {
                        name: 'game-initialized',
                        expression:
                          'document.querySelector("#game")?.textContent === "ready"',
                      },
                    ],
                  },
                }
              : tools.length === 3
                ? {
                    name: 'export_workspace_file',
                    arguments: { path: 'apps/workspace-game.html' },
                  }
                : undefined;
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      if (call) {
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${tools.length + 1}`,
                      function: {
                        name: call.name,
                        arguments: JSON.stringify(call.arguments),
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
                  content: 'workspace resource flow complete',
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
  await new Promise<void>((resolve) =>
    server.listen(0, '127.0.0.1', resolve)
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('No workspace resource server address');
  }
  modelUrl = `http://127.0.0.1:${address.port}/v1`;
  userDataDir = await mkdtemp(join(tmpdir(), 'tinyai-workspace-resource-'));
  context = await launchE2EChrome(userDataDir);
});

afterAll(async () => {
  await context?.close();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => (error ? reject(error) : resolve()))
  );
  if (userDataDir) await rm(userDataDir, { recursive: true, force: true });
});

describe('REQ-CHROME-002 workspace resource E2E', () => {
  it('writes, previews, verifies and exports an isolated HTML app', async () => {
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(
      async ({ url }) => {
        await chrome.storage.local.clear();
        await chrome.storage.local.set({
          'tinyai:v2:config': {
            approval: 'auto',
            language: 'en',
            theme: 'light',
            zoom: 100,
            connection: 'workspace',
            model: 'workspace-model',
            connections: [
              {
                id: 'workspace',
                label: 'Workspace',
                'base-url': url,
                'api-key': 'workspace-key',
                models: ['workspace-model'],
              },
            ],
          },
        });
      },
      { url: modelUrl }
    );
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    await page.waitForSelector('#kernel-input');
    const tabId = await page.evaluate(async () => {
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
    await page.click(`[data-kernel-tab="${tabId}"]`);
    await page.waitForFunction(
      (id) => document.documentElement.dataset.tinyaiTabId === id,
      tabId
    );
    const workspaceId = await page.evaluate(
      () => document.documentElement.dataset.tinyaiWorkspaceId
    );
    expect(workspaceId).toMatch(/^ws_/);
    await page.fill('#kernel-input', 'workspace resource flow');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#kernel-rows')
          ?.textContent?.includes('workspace resource flow complete'),
      undefined,
      { timeout: 20_000 }
    );
    expect(toolResults.map((item) => item.name)).toEqual([
      'write_file',
      'open_workspace_file',
      'verify_workspace_file',
      'export_workspace_file',
    ]);
    expect(JSON.parse(toolResults[0]!.content)).toMatchObject({
      workspaceId,
      path: 'apps/workspace-game.html',
    });
    expect(JSON.parse(toolResults[2]!.content)).toMatchObject({
      workspaceId,
      path: 'apps/workspace-game.html',
      loaded: true,
      consoleErrors: [],
      assertions: expect.arrayContaining([
        expect.objectContaining({
          name: 'game-initialized',
          passed: true,
        }),
      ]),
    });
    expect(JSON.parse(toolResults[3]!.content)).toMatchObject({
      bytes: expect.any(Number),
      destination: 'download',
      path: 'apps/workspace-game.html',
    });
    const projection = await page.evaluate(() => ({
      taskStatus:
        document.querySelector('.wb-session-status')?.textContent ?? '',
      rows: document.querySelector('#kernel-rows')?.textContent ?? '',
    }));
    expect(projection.rows).not.toContain('Failed');
    const downloads = await worker.evaluate(async () =>
      chrome.downloads.search({})
    );
    expect(downloads.some((item) => item.state === 'complete')).toBe(true);
    await worker.evaluate(async () => {
      const tabs = await chrome.tabs.query({});
      const previews = tabs.filter((tab) =>
        tab.url?.includes('workspace-preview.html')
      );
      if (previews.length) {
        await chrome.tabs.remove(
          previews.flatMap((tab) => (tab.id === undefined ? [] : [tab.id]))
        );
      }
    });
  });

  it('keeps a standalone tab workspace isolated from the first tab', async () => {
    const page = context
      .pages()
      .find((candidate) => candidate.url().includes('/sidepanel.html'));
    if (!page) throw new Error('Side Panel page not found');
    const firstWorkspaceId = await page.evaluate(
      () => document.documentElement.dataset.tinyaiWorkspaceId
    );
    const secondTabId = await page.evaluate(async () => {
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
    await page.click(`[data-kernel-tab="${secondTabId}"]`);
    await page.waitForFunction(
      (id) => document.documentElement.dataset.tinyaiTabId === id,
      secondTabId
    );
    const secondWorkspaceId = await page.evaluate(
      () => document.documentElement.dataset.tinyaiWorkspaceId
    );
    expect(secondWorkspaceId).toMatch(/^ws_/);
    expect(secondWorkspaceId).not.toBe(firstWorkspaceId);
    await page.fill('#kernel-input', 'workspace isolation check');
    await page.click('#kernel-send');
    await page.waitForFunction(
      () =>
        document
          .querySelector('#kernel-rows')
          ?.textContent?.includes('workspace isolation complete'),
      undefined,
      { timeout: 15_000 }
    );
    expect(isolationResults).toHaveLength(1);
    expect(isolationResults[0]).not.toContain(
      'apps/workspace-game.html'
    );
  });
});
