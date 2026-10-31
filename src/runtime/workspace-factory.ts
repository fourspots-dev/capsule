import type { BrowserProvider } from '../core/browser-provider';
import type { ArtifactStore } from '../core/artifact-store';
import type { HookRunner } from '../core/hooks';
import { AgentError } from '../core/errors';
import type {
  ApprovalPort,
  Clock,
  HandoffPort,
  IdGenerator,
  ModelTransport,
} from '../core/ports';
import type { SessionStore } from '../core/session-store';
import { PermissionModeRegistry, PolicyEngine } from '../core/policy';
import { ToolExecutor } from '../core/tool-executor';
import { ToolRegistry, type ToolRegistration } from '../core/tool-registry';
import type { ToolDefinition } from '../core/types';
import type { TraceRecorder } from '../core/trace-recorder';
import { WorkspaceRuntime, type WorkspaceRuntimeOptions } from '../core/workspace-runtime';
import { createBrowserTools } from '../adapters/browser-tools';

export interface BrowserWorkspaceFactoryOptions {
  model: ModelTransport;
  browser: BrowserProvider;
  sessionStore: SessionStore;
  approval: ApprovalPort;
  clock: Clock;
  ids: IdGenerator;
  systemPrompt?: string;
  maxSteps?: number;
  defaultToolTimeoutMs?: number;
  toolSelection?: {
    allow?: string[];
    deny?: string[];
    capabilities?: string[];
  };
  additionalTools?: ToolRegistration[];
  download?: (name: string, mime: string, base64: string) => Promise<void>;
  handoff?: HandoffPort;
  permissionModes?: PermissionModeRegistry;
  artifactStore?: ArtifactStore;
  artifactThresholdBytes?: number;
  trace?: TraceRecorder;
  hooks?: HookRunner;
  tabScoped?: boolean;
}

export interface BrowserWorkspaceBundle {
  runtime: WorkspaceRuntime;
  tools: ToolExecutor;
  registry: ToolRegistry;
  dispose(): Promise<void>;
}

export function createBrowserWorkspace(
  options: BrowserWorkspaceFactoryOptions
): BrowserWorkspaceBundle {
  const registry = new ToolRegistry();
  const browserTools = createBrowserTools(options.browser, {
    download: options.download,
    handoff: options.handoff,
    tabScoped: options.tabScoped,
  });
  registry.registerAll(
    browserTools.map((definition) => ({ definition, source: 'builtin' as const }))
  );
  registry.registerAll(options.additionalTools ?? []);
  const selected = registry.resolve(options.toolSelection ?? {});
  const permissionModes =
    options.permissionModes ?? new PermissionModeRegistry('guarded', () => options.clock.now());
  const tools = new ToolExecutor(selected, options.approval, {
    defaultTimeoutMs: options.defaultToolTimeoutMs,
    policy: new PolicyEngine((sessionId) => permissionModes.mode(sessionId)),
    artifacts: options.artifactStore
      ? {
          store: options.artifactStore,
          thresholdBytes: options.artifactThresholdBytes,
        }
      : undefined,
    hooks: options.hooks,
  });
  const runtimeOptions: WorkspaceRuntimeOptions = {
    model: options.model,
    tools,
    clock: options.clock,
    ids: options.ids,
    sessionStore: options.sessionStore,
    permissionModes,
    trace: options.trace,
    maxSteps: options.maxSteps,
    systemPrompt: options.systemPrompt,
    onOpen: async (sessionId) => {
      await options.browser.ensureTaskGroup(sessionId);
    },
    onClose: async (sessionId) => {
      const report = await options.browser.closeSessionTabs(sessionId);
      if (report.errors.length > 0) {
        throw new AgentError(
          'BROWSER_SESSION_CLEANUP_FAILED',
          report.errors.map((error) => `${error.code}: ${error.message}`).join('; '),
          { details: report.errors as unknown as import('../core/types').JsonValue }
        );
      }
    },
  };
  const runtime = new WorkspaceRuntime(runtimeOptions);
  return {
    runtime,
    tools,
    registry,
    async dispose() {
      await runtime.dispose();
      const disposable = options.browser as BrowserProvider & { dispose?: () => void };
      disposable.dispose?.();
    },
  };
}

export function toolDefinitionsOf(registrations: readonly ToolRegistration[]): ToolDefinition[] {
  return registrations.map((registration) => registration.definition);
}
