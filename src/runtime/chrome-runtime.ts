import { ChromeBrowserProvider } from '../adapters/chrome-browser';
import { ChromeArtifactStore } from '../adapters/chrome-artifact-store';
import { HttpMcpClient, HttpMcpTransport } from '../adapters/mcp-http';
import { ChromeSessionStore } from '../adapters/chrome-session-store';
import { ChromeSkillStore } from '../adapters/chrome-skill-store';
import { OpenAIModelTransport } from '../adapters/openai-model';
import { createSubagentTools } from '../adapters/subagent-tools';
import { createSkillTools } from '../adapters/skill-tools';
import { registerDeclarativeHooks } from '../adapters/declarative-hooks';
import { SubagentCoordinator } from '../core/subagent-coordinator';
import { ExtensionRegistry } from '../core/extension-registry';
import { HookRunner } from '../core/hooks';
import type { ToolDefinition } from '../core/types';
import { TraceRecorder } from '../core/trace-recorder';
import { AgentError } from '../core/errors';
import { SequentialIdGenerator, systemClock } from '../core/ports';
import { PermissionModeRegistry } from '../core/policy';
import { ModelGateway } from '../core/model-gateway';
import { chromePromptProfile } from '../adapters/chrome-prompts';
import { PortApprovalBroker } from './approval-broker';
import type { RuntimeBundle } from './runtime-gateway';
import { RuntimeGateway } from './runtime-gateway';
import type { RuntimePort, RuntimeRequest } from './protocol';
import { createBrowserWorkspace } from '../adapters/browser-workspace-factory';
import { createDefaultProfileRegistry, loadAgentProfiles } from './profile-loader';
import { WorkspaceSubagentDriver } from './workspace-subagent-driver';
import { TabSessionRegistry } from '../adapters/chrome-workspace-session-registry';
import { ChromeRuntimeExtension } from '../adapters/chrome-runtime-extension';
import { CONFIG_KEY, migrateLegacyStorage } from './storage-migration';

export const KERNEL_PORT_NAME = 'tinyai-runtime-v1';

export interface ChromeKeyValueStorage {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string | string[]): Promise<void>;
}

interface StoredConnection {
  id?: unknown;
  label?: unknown;
  baseUrl?: unknown;
  'base-url'?: unknown;
  apiKey?: unknown;
  'api-key'?: unknown;
  models?: unknown;
}

export interface KernelConnectionConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  approval: 'ask' | 'auto';
  connectionId: string;
}

export function parseKernelConfig(raw: unknown): KernelConnectionConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentError('MODEL_NOT_CONFIGURED', 'No model configuration was found');
  }
  const config = raw as Record<string, unknown>;
  const connections = Array.isArray(config.connections)
    ? (config.connections as StoredConnection[])
    : [];
  const requested = typeof config.connection === 'string' ? config.connection : undefined;
  const connection =
    connections.find((candidate) => candidate.id === requested) ??
    connections[0];
  if (!connection) {
    throw new AgentError(
      'MODEL_NOT_CONFIGURED',
      'Configure an OpenAI-compatible connection before using the kernel runtime'
    );
  }
  const apiKey = stringValue(connection.apiKey ?? connection['api-key']);
  const baseUrl = stringValue(connection.baseUrl ?? connection['base-url']).replace(/\/+$/, '');
  if (!apiKey || !baseUrl) {
    throw new AgentError(
      'MODEL_CONFIGURATION_INVALID',
      'The selected connection requires both base URL and API key'
    );
  }
  const models = Array.isArray(connection.models)
    ? connection.models.map(String).filter(Boolean)
    : [];
  const model = stringValue(config.model) || models[0] || 'deepseek-chat';
  return {
    baseUrl,
    apiKey,
    model,
    approval: config.approval === 'auto' ? 'auto' : 'ask',
    connectionId: stringValue(connection.id) || 'default',
  };
}

export async function createChromeRuntimeBundle(
  options: {
    storage?: ChromeKeyValueStorage;
    tabSessionStorage?: ChromeKeyValueStorage;
    chromeApi?: typeof chrome;
    browser?: ChromeBrowserProvider;
    createBrowser?: () => ChromeBrowserProvider;
  } = {}
): Promise<RuntimeBundle> {
  const storage = options.storage ?? chromeLocalStorage();
  const sessionStore = new ChromeSessionStore({
    storage: chromeStorageForSessions(storage),
  });
  await migrateLegacyStorage(storage, sessionStore, systemClock.now());
  const stored = await storage.get(CONFIG_KEY);
  const config = parseKernelConfig(stored[CONFIG_KEY]);
  const profiles = await storage.get('tinyai-agent-profiles');
  const mcpConfig = await storage.get('tinyai-mcp-servers');
  const hookConfig = await storage.get('tinyai-declarative-hooks');
  const approval = new PortApprovalBroker({ mode: config.approval });
  const browser =
    options.browser ??
    options.createBrowser?.() ??
    new ChromeBrowserProvider();
  const model = new ModelGateway({
    targets: [
      {
        id: config.connectionId,
        attempts: 2,
        transport: new OpenAIModelTransport({
          baseUrl: config.baseUrl,
          apiKey: config.apiKey,
          model: config.model,
        }),
      },
    ],
  });
  const artifactStore = new ChromeArtifactStore(
    storage as ChromeKeyValueStorage & {
      get(keys: string | string[] | null): Promise<Record<string, unknown>>;
    }
  );
  const hooks = new HookRunner();
  await registerDeclarativeHooks(hooks, hookConfig['tinyai-declarative-hooks']);
  const ids = new SequentialIdGenerator();
  const trace = new TraceRecorder(`trace_${crypto.randomUUID()}`, () => systemClock.now());
  const permissionModes = new PermissionModeRegistry(
    config.approval === 'auto' ? 'build' : 'guarded',
    () => systemClock.now()
  );
  const extensions = new ExtensionRegistry();
  const skillStore = new ChromeSkillStore(storage);
  const initialSkills = await skillStore.list();
  extensions.register({
    id: 'tinyai.skills',
    name: 'tinyai skills',
    version: '1',
    source: 'builtin',
    skills: initialSkills,
  });
  const skillTools = createSkillTools(extensions, skillStore);
  const mcpClients: HttpMcpClient[] = [];
  const mcpTools: ToolDefinition[] = [];
  for (const server of parseMcpServers(mcpConfig['tinyai-mcp-servers'])) {
    try {
      const client = new HttpMcpClient(
        new HttpMcpTransport({
          url: server.url,
          headers: server.headers,
        }),
        server.name
      );
      await client.initialize();
      mcpTools.push(...(await client.definitions()));
      mcpClients.push(client);
    } catch (error) {
      console.warn(`tinyai MCP server ${server.name} failed to initialize`, error);
    }
  }
  const registry = createDefaultProfileRegistry(
    loadAgentProfiles(profiles['tinyai-agent-profiles'])
  );
  const rootPermissions = {
    capabilities: [
      'browser:read',
      'browser:navigate',
      'browser:interact',
      'browser:script',
      'browser:network',
      'agent:spawn',
      'agent:manage',
      'extension:skills',
      'mcp:call',
    ],
    effects: ['read', 'write', 'execute', 'network'] as const,
  };
  const subagentDriver = new WorkspaceSubagentDriver({
    ids,
    now: () => systemClock.now(),
    createRuntime: ({ sessionId, spec, profile }) =>
      createBrowserWorkspace({
        model,
        browser,
        sessionStore,
        approval,
        handoff: approval,
        clock: systemClock,
        ids,
        permissionModes,
        artifactStore,
        trace,
        hooks,
        systemPrompt: chromePromptProfile.build({
          profile,
          skills: initialSkills,
        }),
        maxSteps: spec.budget.maxTurns,
        toolSelection: {
          allow: profile.tools.allow,
          deny: profile.tools.deny,
          capabilities: profile.effectivePermissions.capabilities,
        },
        additionalTools: [
          ...skillTools.map((definition) => ({
            definition,
            source: 'builtin' as const,
            sourceId: 'skills',
          })),
          ...mcpTools.map((definition) => ({
            definition,
            source: 'plugin' as const,
            sourceId: 'mcp',
          })),
        ],
        tabScoped: true,
      }).runtime,
  });
  let mainWorkspace: ReturnType<typeof createBrowserWorkspace>;
  let tabSessions: TabSessionRegistry | undefined;
  const workspaceTabs = {
    createTab: (sessionId: string, url?: string) =>
      requireTabSessions().createTab(sessionId, url),
    switchTab: (sessionId: string, tabId: string) =>
      requireTabSessions().switchTab(sessionId, tabId),
    listTabs: (sessionId: string) => requireTabSessions().listTabs(sessionId),
  };
  const requireTabSessions = (): TabSessionRegistry => {
    if (!tabSessions) {
      throw new AgentError('WORKSPACE_NOT_READY', 'Browser workspace is not initialized');
    }
    return tabSessions;
  };
  const coordinator = new SubagentCoordinator({
    registry,
    driver: subagentDriver,
    ids,
    now: () => systemClock.now(),
    contextProvider: async (parentTaskId) =>
      mainWorkspace.runtime.contextForTask(parentTaskId),
  });
  const subagentTools = createSubagentTools({
    coordinator,
    parent: (invocation) => ({
      taskId: invocation.taskId,
      depth: 0,
      maxDepth: 2,
      permissions: {
        capabilities: [...rootPermissions.capabilities],
        effects: [...rootPermissions.effects],
      },
    }),
  });
  mainWorkspace = createBrowserWorkspace({
    model,
    browser,
    sessionStore,
    approval,
    handoff: approval,
    clock: systemClock,
    ids,
    permissionModes,
    artifactStore,
    trace,
    hooks,
    systemPrompt: chromePromptProfile.build({ skills: initialSkills }),
    download: async (name, mime, base64) => {
      await chrome.downloads.download({
        url: `data:${mime};base64,${base64}`,
        filename: name,
        saveAs: false,
      });
    },
    additionalTools: [
      ...subagentTools.map((definition) => ({
        definition,
        source: 'builtin' as const,
        sourceId: 'subagents',
      })),
      ...skillTools.map((definition) => ({
        definition,
        source: 'builtin' as const,
        sourceId: 'skills',
      })),
      ...mcpTools.map((definition) => ({
        definition,
        source: 'plugin' as const,
        sourceId: 'mcp',
      })),
    ],
    workspaceTabs,
  });
  const unsubscribeChildren = coordinator.subscribe((child) => {
    mainWorkspace.runtime.updateChildTask(child.parentTaskId, {
      taskId: child.taskId,
      sessionId: child.sessionId,
      parentTaskId: child.parentTaskId,
      ...(child.parentSessionId ? { parentSessionId: child.parentSessionId } : {}),
      profileName: child.profileName,
      status: child.status,
      executionMode: child.executionMode,
      ...(child.result?.summary ? { summary: child.result.summary } : {}),
      ...(child.completedAt ? { updatedAt: child.completedAt } : {}),
    });
  });
  tabSessions = new TabSessionRegistry({
    runtime: mainWorkspace.runtime,
    browser,
    storage: options.tabSessionStorage,
  });
  const extension = new ChromeRuntimeExtension(
    mainWorkspace.runtime,
    tabSessions,
    browser,
    options.chromeApi ?? chrome
  );
  return {
    runtime: mainWorkspace.runtime,
    extension,
    approval,
    skills: () => skillStore.list(),
    artifacts: artifactStore,
    async dispose() {
      await extension.dispose();
      unsubscribeChildren();
      approval.dispose();
      await coordinator.dispose();
      await mainWorkspace.dispose();
      await Promise.all(mcpClients.map((client) => client.close()));
    },
  };
}

export function installKernelRuntimeGateway(
  chromeApi: typeof chrome = chrome
): RuntimeGateway {
  const gateway = new RuntimeGateway(async () =>
    createChromeRuntimeBundle({
      storage: chromeApi.storage.local,
      tabSessionStorage: chromeApi.storage.session as unknown as ChromeKeyValueStorage,
      chromeApi,
    })
  );
  chromeApi.runtime.onConnect.addListener((port) => {
    if (port.name !== KERNEL_PORT_NAME) return;
    gateway.connect(asRuntimePort(port));
    void ensureRuntimeOffscreen(chromeApi);
  });
  return gateway;
}

async function ensureRuntimeOffscreen(chromeApi: typeof chrome): Promise<void> {
  if (!chromeApi.offscreen) return;
  try {
    const contexts = await chromeApi.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chromeApi.runtime.getURL('offscreen.html')],
    });
    if (contexts.length > 0) return;
    await chromeApi.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Keep the authoritative agent runtime alive while the side panel is closed.',
    });
  } catch {
    // Existing Chrome versions may reject overlapping creation; the runtime still remains operational.
  }
}

function asRuntimePort(port: chrome.runtime.Port): RuntimePort {
  const messageWrappers = new Map<
    (message: RuntimeRequest | import('./protocol').RuntimeResponse) => void,
    (message: unknown) => void
  >();
  const disconnectWrappers = new Map<() => void, () => void>();
  return {
    postMessage: (message) => port.postMessage(message),
    onMessage: {
      addListener: (listener) => {
        const wrapped = (message: unknown) => listener(message as RuntimeRequest);
        messageWrappers.set(listener, wrapped);
        port.onMessage.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = messageWrappers.get(listener);
        if (!wrapped) return;
        port.onMessage.removeListener(wrapped);
        messageWrappers.delete(listener);
      },
    },
    onDisconnect: {
      addListener: (listener) => {
        const wrapped = () => listener();
        disconnectWrappers.set(listener, wrapped);
        port.onDisconnect.addListener(wrapped);
      },
      removeListener: (listener) => {
        const wrapped = disconnectWrappers.get(listener);
        if (!wrapped) return;
        port.onDisconnect.removeListener(wrapped);
        disconnectWrappers.delete(listener);
      },
    },
  };
}

function chromeLocalStorage(): ChromeKeyValueStorage {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    throw new AgentError(
      'CHROME_STORAGE_UNAVAILABLE',
      'chrome.storage.local is unavailable'
    );
  }
  return chrome.storage.local;
}

function chromeStorageForSessions(storage: ChromeKeyValueStorage) {
  return {
    get: async (keys: string | string[] | null) => storage.get(keys),
    set: (items: Record<string, unknown>) => storage.set(items),
    remove: async (keys: string | string[]) => {
      if (!storage.remove) {
        throw new AgentError(
          'CHROME_STORAGE_UNAVAILABLE',
          'chrome.storage.local.remove is unavailable'
        );
      }
      await storage.remove(keys);
    },
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseMcpServers(value: unknown): Array<{
  name: string;
  url: string;
  headers?: Record<string, string>;
}> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const item = entry as Record<string, unknown>;
    const name = stringValue(item.name);
    const url = stringValue(item.url);
    if (!name || !/^https?:\/\//.test(url)) return [];
    const headers =
      item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
        ? Object.fromEntries(
            Object.entries(item.headers as Record<string, unknown>).map(([key, header]) => [
              key,
              String(header),
            ])
          )
        : undefined;
    return [{ name, url, ...(headers ? { headers } : {}) }];
  });
}
