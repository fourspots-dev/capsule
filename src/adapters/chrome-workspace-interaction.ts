import { AgentError } from '../core/errors';
import { bytesToBase64 } from '../git/binary';
import type {
  WorkspaceExportPort,
  WorkspaceExportResult,
  WorkspaceInteractionProvider,
  WorkspaceOpenPort,
  WorkspaceOpenResult,
  WorkspaceOpenCapabilities,
  WorkspaceExportCapabilities,
  WorkspaceVerificationPort,
  WorkspaceVerifyCapabilities,
  WorkspaceApplicationObservation,
} from '../platform/workspace-interaction';
import {
  workspaceMimeType,
  type WorkspaceResourceRef,
} from '../platform/workspace-resource';
import type { ChromeWorkspaceScopeRegistry } from '../runtime/chrome-workspace-scope';
import type { ChromeBrowserProvider } from './chrome-browser';

export class ChromeWorkspaceInteractionProvider
  implements WorkspaceInteractionProvider
{
  readonly hostId = 'chrome';
  readonly open: WorkspaceOpenPort;
  readonly export: WorkspaceExportPort;
  readonly verify: WorkspaceVerificationPort;

  constructor(
    private readonly options: {
      chromeApi: typeof chrome;
      workspaces: ChromeWorkspaceScopeRegistry;
      browser?: ChromeBrowserProvider;
    }
  ) {
    this.open = {
      capabilities: () => this.openCapabilities(),
      open: (resource, options, signal) =>
        this.openResource(resource, options, signal),
    };
    this.export = {
      capabilities: () => this.exportCapabilities(),
      export: (resource, signal) =>
        this.exportResource(resource, signal),
    };
    this.verify = {
      capabilities: () => this.verifyCapabilities(),
      verify: (resource, options, signal) =>
        this.verifyResource(resource, options, signal),
    };
  }

  async capabilities() {
    return {
      open: await this.openCapabilities(),
      export: await this.exportCapabilities(),
      verify: await this.verifyCapabilities(),
    };
  }

  private async openCapabilities(): Promise<WorkspaceOpenCapabilities> {
    return {
      available: true,
      modes: ['embedded-preview'],
    };
  }

  private async exportCapabilities(): Promise<WorkspaceExportCapabilities> {
    return {
      available: true,
      destinations: ['download'],
    };
  }

  private async verifyCapabilities(): Promise<WorkspaceVerifyCapabilities> {
    return {
      available: Boolean(this.options.browser),
      assertions: Boolean(this.options.browser),
      console: false,
      screenshot: false,
    };
  }

  private async openResource(
    resource: WorkspaceResourceRef,
    options: { intent: 'preview' | 'edit' | 'debug'; ephemeral: boolean },
    signal?: AbortSignal
  ): Promise<WorkspaceOpenResult> {
    if (signal?.aborted) {
      throw new AgentError(
        'WORKSPACE_OPEN_CANCELLED',
        'Workspace preview was cancelled'
      );
    }
    await this.assertCurrent(resource);
    const url = new URL(
      this.options.chromeApi.runtime.getURL('workspace-preview.html')
    );
    url.searchParams.set('workspaceId', resource.workspaceId);
    url.searchParams.set('path', resource.path);
    url.searchParams.set('intent', options.intent);
    const tab = await this.options.chromeApi.tabs.create({
      url: url.toString(),
      active: false,
    });
    if (tab.id === undefined) {
      throw new AgentError(
        'WORKSPACE_OPEN_FAILED',
        'Chrome did not return a preview tab id'
      );
    }
    return {
      mode: 'embedded-preview',
      resource,
      targetId: String(tab.id),
    };
  }

  private async exportResource(
    resource: WorkspaceResourceRef,
    signal?: AbortSignal
  ): Promise<WorkspaceExportResult> {
    await this.assertCurrent(resource);
    if (signal?.aborted) {
      throw new AgentError(
        'WORKSPACE_OPEN_CANCELLED',
        'Workspace export was cancelled'
      );
    }
    const bytes = await this.options.workspaces.read(
      resource.workspaceId,
      resource.path
    );
    const mimeType = workspaceMimeType(resource.path);
    const downloadId = await this.options.chromeApi.downloads.download({
      url: `data:${mimeType};base64,${bytesToBase64(bytes)}`,
      filename: resource.path.split('/').at(-1) ?? 'workspace-file',
      saveAs: false,
      conflictAction: 'uniquify',
    });
    if (downloadId === undefined) {
      throw new AgentError(
        'WORKSPACE_EXPORT_FAILED',
        'Chrome did not create a workspace download'
      );
    }
    await waitForDownload(this.options.chromeApi, downloadId, signal);
    return {
      artifactId: `chrome-download-${downloadId}`,
      displayName: resource.path.split('/').at(-1) ?? resource.path,
      bytes: bytes.byteLength,
      destination: 'download',
    };
  }

  private async verifyResource(
    resource: WorkspaceResourceRef,
    options: {
      assertions?: ReadonlyArray<{ name: string; expression: string }>;
    },
    signal?: AbortSignal
  ): Promise<Omit<
    WorkspaceApplicationObservation,
    'id' | 'sessionId' | 'taskId' | 'createdAt'
  >> {
    const browser = this.options.browser;
    if (!browser) {
      throw new AgentError(
        'WORKSPACE_VERIFICATION_UNAVAILABLE',
        'Workspace application verification requires a browser provider'
      );
    }
    const opened = await this.openResource(
      resource,
      { intent: 'debug', ephemeral: true },
      signal
    );
    const tabId = opened.targetId;
    if (!tabId) {
      throw new AgentError(
        'WORKSPACE_OPEN_FAILED',
        'Workspace preview did not return a target'
      );
    }
    const frameId = await waitForPreviewFrame(browser, tabId, signal);
    const base = await evaluateAppStable<{
      ready: string;
      bodyLength: number;
    }>(
      browser,
      tabId,
      `(() => ({
        ready: document.readyState,
        bodyLength: (document.body?.innerText ?? '').trim().length
      }))()`,
      { frameId, ...(signal ? { signal } : {}) }
    );
    const assertions: WorkspaceApplicationObservation['assertions'] = [
      {
        name: 'document-loaded',
        passed: base.ready === 'complete' || base.ready === 'interactive',
        detail: base.ready,
      },
      {
        name: 'document-has-content',
        passed: base.bodyLength > 0,
        detail: `${base.bodyLength} visible text characters`,
      },
    ];
    for (const assertion of options.assertions ?? []) {
      if (signal?.aborted) {
        throw new AgentError(
          'WORKSPACE_VERIFY_CANCELLED',
          'Workspace verification was cancelled'
        );
      }
      const passed = await evaluateAppStable<boolean>(
        browser,
        tabId,
        `Boolean(${assertion.expression})`,
        { frameId, ...(signal ? { signal } : {}) }
      );
      assertions.push({
        name: assertion.name,
        passed: passed === true,
      });
    }
    return {
      workspaceId: resource.workspaceId,
      path: resource.path,
      workspaceGeneration: resource.generation,
      loaded: true,
      consoleErrors: [],
      assertions,
    };
  }

  private async assertCurrent(resource: WorkspaceResourceRef): Promise<void> {
    const workspace = await this.options.workspaces.get(resource.workspaceId);
    const generation = await workspace.generation();
    if (generation !== resource.generation) {
      throw new AgentError(
        'WORKSPACE_RESOURCE_STALE',
        'Workspace changed before the resource operation'
      );
    }
  }
}

async function evaluateAppStable<T>(
  browser: ChromeBrowserProvider,
  tabId: string,
  expression: string,
  options: { frameId: string; signal?: AbortSignal }
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      return await browser.evaluate<T>(tabId, expression, options);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Cannot find context')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

async function waitForPreviewFrame(
  browser: ChromeBrowserProvider,
  tabId: string,
  signal?: AbortSignal
): Promise<string> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new AgentError(
        'WORKSPACE_VERIFY_CANCELLED',
        'Workspace verification was cancelled'
      );
    }
    const frames = (await browser.listFrames?.(tabId)) ?? [];
    const preview = frames
      .filter((frame) => !frame.main)
      .find(
        (frame) =>
          !frame.url ||
          frame.url.includes('/sandbox/workspace-app.html') ||
          frame.url.startsWith('blob:') ||
          frame.url.startsWith('data:text/html')
      ) ?? frames.find((frame) => !frame.main);
    if (preview) return preview.frameId;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new AgentError(
    'WORKSPACE_PREVIEW_TIMEOUT',
    'Workspace preview frame did not become ready'
  );
}

async function waitForDownload(
  chromeApi: typeof chrome,
  downloadId: number,
  signal?: AbortSignal
): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new AgentError(
        'WORKSPACE_OPEN_CANCELLED',
        'Workspace export was cancelled'
      );
    }
    const [item] = await chromeApi.downloads.search({ id: downloadId });
    if (item?.state === 'complete') return;
    if (item?.state === 'interrupted') {
      throw new AgentError(
        'WORKSPACE_EXPORT_FAILED',
        item.error ?? 'Chrome download was interrupted'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new AgentError(
    'WORKSPACE_EXPORT_TIMEOUT',
    'Chrome did not complete the workspace download'
  );
}
