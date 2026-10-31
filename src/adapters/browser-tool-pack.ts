import type { BrowserProvider } from './browser-provider';
import {
  createBrowserTools,
  type BrowserToolDependencies,
} from './browser-tools';
import type { ToolPack } from '../platform/tool-pack';

export function createBrowserToolPack(
  browser: BrowserProvider,
  dependencies: BrowserToolDependencies = {}
): ToolPack {
  return {
    id: 'browser',
    register() {
      return createBrowserTools(browser, dependencies).map((definition) => ({
        definition,
        source: 'builtin' as const,
        sourceId: 'browser',
      }));
    },
  };
}
