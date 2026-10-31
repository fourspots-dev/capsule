import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const options = parseArgs(process.argv.slice(2));
const capsuleBase64 = (await readFile(options.capsule)).toString('base64');
const harness = await readFile(resolve('dist/chrome-capsule-harness.js'));
const server = createServer((request, response) => {
  if (request.url === '/harness.js') {
    response.writeHead(200, {
      'Content-Type': 'text/javascript; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    response.end(harness);
    return;
  }
  response.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end('<!doctype html><html><body></body></html>');
});
await new Promise((resolveServer) =>
  server.listen(0, '127.0.0.1', () => resolveServer())
);
const address = server.address();
if (!address || typeof address === 'string') {
  throw new Error('Could not start the Chrome harness server');
}
const baseUrl = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.CHROME_PATH ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: ['--use-angle=swiftshader', '--enable-webgl'],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error' && !message.text().includes('favicon')) {
    errors.push(message.text());
  }
});
try {
  await page.goto(baseUrl, { waitUntil: 'load' });
  await page.addScriptTag({ url: `${baseUrl}/harness.js` });
  const imported = await page.evaluate(
    async ({ capsule, environmentId }) =>
      window.tinyaiChromeHarness.importAndStage(capsule, environmentId),
    { capsule: capsuleBase64, environmentId: 'chrome-extension-v1' }
  );
  await page.evaluate(
    (files) => window.tinyaiChromeHarness.stageGame(files),
    imported.files
  );
  const frame = page.frameLocator('#tinyai-game-frame');
  await frame.locator('#btn-start').click({ timeout: 15_000 });
  await frame.locator('body').press('Space');
  await page.waitForTimeout(2_000);
  const game = await frame.locator('body').evaluate(() => ({
    status: document.querySelector('#app')?.getAttribute('data-status'),
    score: document.querySelector('#score')?.textContent,
    wave: document.querySelector('#wave')?.textContent,
    enemies: document.querySelector('#enemies')?.textContent,
    fatal: document.querySelector('#fatal')?.textContent,
    hasGame: Boolean(window.__VOID_LANCE__),
  }));
  await page.screenshot({ path: options.screenshot, fullPage: true });
  if (options.exportCapsule) {
    await writeFile(
      options.exportCapsule,
      Buffer.from(imported.exportedCapsuleBase64, 'base64')
    );
  }
  console.log(
    JSON.stringify(
      {
        imported: imported.imported,
        host: imported.capability,
        sessions: imported.sessions,
        gitCommits: imported.gitLog.map((commit) => ({
          oid: commit.oid,
          message: commit.message.trim(),
        })),
        game,
        errors,
        screenshot: options.screenshot,
        exportedCapsule: options.exportCapsule,
      },
      null,
      2
    )
  );
  if (
    errors.length ||
    game.status !== 'playing' ||
    !game.hasGame ||
    game.fatal
  ) {
    process.exitCode = 1;
  }
} finally {
  await browser.close();
  await new Promise((resolveServer) => server.close(() => resolveServer()));
}

function parseArgs(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg !== '--capsule' &&
      arg !== '--screenshot' &&
      arg !== '--export-capsule'
    ) {
      throw new Error(`Unknown argument: ${arg}`);
    }
    const value = args[++index];
    if (!value) throw new Error(`${arg} requires a value`);
    values.set(arg, resolve(value));
  }
  if (!values.get('--capsule') || !values.get('--screenshot')) {
    throw new Error('--capsule and --screenshot are required');
  }
  return {
    capsule: values.get('--capsule'),
    screenshot: values.get('--screenshot'),
    exportCapsule: values.get('--export-capsule'),
  };
}
