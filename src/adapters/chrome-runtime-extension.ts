import type { ChromeBrowserProvider } from './chrome-browser';
import type { TabSessionRegistry } from './chrome-workspace-session-registry';
import type { WorkspaceRuntime } from '../core/workspace-runtime';
import { AgentError } from '../core/errors';
import type {
  RuntimeExtension,
  RuntimeExtensionRequest,
  RuntimeExtensionResult,
} from '../platform/runtime-extension';

export class ChromeRuntimeExtension implements RuntimeExtension {
  private readonly onTabRemoved = (
    tabId: number,
    info: chrome.tabs.OnRemovedInfo
  ): void => {
    void this.tabs.forget({
      windowId: info.windowId,
      tabId: String(tabId),
    });
  };

  constructor(
    private readonly runtime: WorkspaceRuntime,
    private readonly tabs: TabSessionRegistry,
    private readonly browser: ChromeBrowserProvider,
    private readonly chromeApi: typeof chrome
  ) {
    this.chromeApi.tabs.onRemoved.addListener(this.onTabRemoved);
  }

  async tryHandle(
    request: RuntimeExtensionRequest
  ): Promise<RuntimeExtensionResult> {
    if (request.type === 'list_tabs') {
      return { handled: true, data: await this.browser.listTabs() };
    }
    if (request.type === 'select_tab') {
      await this.browser.setWorkingTab(
        requiredString(request, 'sessionId'),
        requiredString(request, 'tabId')
      );
      return { handled: true, data: true };
    }
    if (request.type === 'resolve_tab_session') {
      return this.activate(request, 'resolve');
    }
    if (request.type === 'create_tab_session') {
      return this.activate(request, 'create');
    }
    if (request.type === 'bind_tab_session') {
      const binding = await this.tabs.bind(
        activationContext(request),
        requiredString(request, 'sessionId')
      );
      return {
        handled: true,
        data: {
          ...binding,
          projection: await this.runtime.loadProjection(binding.sessionId),
        },
      };
    }
    if (request.type === 'forget_tab_session') {
      await this.tabs.forget(activationContext(request));
      return { handled: true, data: true };
    }
    return { handled: false };
  }

  async beforeDeleteSession(sessionId: string): Promise<void> {
    await this.tabs.releaseSession(sessionId);
  }

  async beforeClearHistory(): Promise<void> {
    await this.tabs.clear();
  }

  dispose(): void {
    this.chromeApi.tabs.onRemoved.removeListener(this.onTabRemoved);
  }

  private async activate(
    request: RuntimeExtensionRequest,
    mode: 'resolve' | 'create'
  ): Promise<RuntimeExtensionResult> {
    const context = activationContext(request);
    const binding =
      mode === 'resolve'
        ? await this.tabs.resolve(context)
        : await this.tabs.create(context);
    return {
      handled: true,
      data: {
        ...binding,
        projection: await this.runtime.loadProjection(binding.sessionId),
      },
    };
  }
}

function activationContext(request: RuntimeExtensionRequest): {
  windowId: number;
  tabId: string;
  groupId?: number;
} {
  const windowId = Number(request.windowId);
  const tabId = requiredString(request, 'tabId');
  if (!Number.isFinite(windowId)) {
    throw new AgentError('TAB_CONTEXT_INVALID', 'A valid windowId is required');
  }
  const groupId = Number(request.groupId);
  return {
    windowId,
    tabId,
    ...(Number.isFinite(groupId) && groupId >= 0 ? { groupId } : {}),
  };
}

function requiredString(
  request: RuntimeExtensionRequest,
  key: string
): string {
  const value = request[key];
  if (typeof value !== 'string' || !value) {
    throw new AgentError(
      'RUNTIME_EXTENSION_INVALID_REQUEST',
      `Missing ${key}`
    );
  }
  return value;
}
