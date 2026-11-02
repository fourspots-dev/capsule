import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  chromium,
  type BrowserContext,
} from 'playwright-core';

export type ChromeE2EChannel = 'cft' | 'stable' | 'auto';

export function chromeE2EHeadless(): boolean {
  return process.env.TINYAI_E2E_HEADED !== '1';
}

export function chromeE2EExecutable(
  channel = (process.env.TINYAI_E2E_CHROME ?? 'cft') as ChromeE2EChannel
): string {
  const explicit =
    process.env.TINYAI_CHROME_EXECUTABLE ??
    (channel === 'cft' ? process.env.CHROME_FOR_TESTING_PATH : process.env.CHROME_PATH);
  if (explicit) {
    if (!existsSync(explicit)) {
      throw new Error(`Configured Chrome executable does not exist: ${explicit}`);
    }
    return explicit;
  }
  if (channel === 'cft' || channel === 'auto') {
    const cft = chromeForTestingCandidates().find(existsSync);
    if (cft) return cft;
    if (channel === 'cft') {
      throw new Error(
        'Chrome for Testing is required. Run `npx playwright install chromium` or set CHROME_FOR_TESTING_PATH.'
      );
    }
  }
  if (channel === 'stable' || channel === 'auto') {
    const stable = stableChromeCandidates().find(existsSync);
    if (stable) return stable;
  }
  throw new Error(
    `No ${channel} Chrome executable found; set TINYAI_CHROME_EXECUTABLE`
  );
}

export function launchE2EChrome(
  userDataDir: string,
  extraArgs: string[] = []
): Promise<BrowserContext> {
  return chromium.launchPersistentContext(userDataDir, {
    headless: chromeE2EHeadless(),
    executablePath: chromeE2EExecutable(),
    args: [
      `--disable-extensions-except=${resolve('extension')}`,
      `--load-extension=${resolve('extension')}`,
      '--no-first-run',
      ...extraArgs,
    ],
    ignoreDefaultArgs: ['--disable-extensions'],
  });
}

function chromeForTestingCandidates(): string[] {
  const candidates = [chromium.executablePath()];
  const cache = playwrightCacheDirectory();
  if (cache && existsSync(cache)) {
    const versionDirectories = readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort(compareVersionDirectories)
      .reverse();
    for (const directory of versionDirectories) {
      const root = join(cache, directory);
      candidates.push(
        join(
          root,
          'chrome-mac-arm64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        ),
        join(
          root,
          'chrome-mac-x64',
          'Google Chrome for Testing.app',
          'Contents',
          'MacOS',
          'Google Chrome for Testing'
        ),
        join(root, 'chrome-linux', 'chrome'),
        join(root, 'chrome-win', 'chrome.exe')
      );
    }
  }
  candidates.push(
    '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
  );
  return candidates;
}

function stableChromeCandidates(): string[] {
  return [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
}

function playwrightCacheDirectory(): string | undefined {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) {
    return process.env.PLAYWRIGHT_BROWSERS_PATH;
  }
  const home = homedir();
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Caches', 'ms-playwright');
  }
  if (process.platform === 'linux') {
    return join(home, '.cache', 'ms-playwright');
  }
  if (process.platform === 'win32') {
    return join(home, 'AppData', 'Local', 'ms-playwright');
  }
  return undefined;
}

function compareVersionDirectories(left: string, right: string): number {
  return Number(left.slice('chromium-'.length)) - Number(right.slice('chromium-'.length));
}
