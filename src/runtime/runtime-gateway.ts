import { createProjectionFrame, type ProjectionFrame } from '../core/projection';
import type { ProductProjection } from '../core/types';
import type { WorkspaceRuntime } from '../core/workspace-runtime';
import type { SkillDefinition } from '../core/extension-registry';
import type { ArtifactStore } from '../core/artifact-store';
import type { BrowserProvider } from '../core/browser-provider';
import { AgentError, toStructuredError } from '../core/errors';
import type { PortApprovalBroker } from './approval-broker';
import type { RuntimePort, RuntimeRequest, RuntimeResponse } from './protocol';
import type { TabSessionRegistry } from './tab-session-registry';

export interface RuntimeBundle {
  runtime: WorkspaceRuntime;
  tabSessions?: TabSessionRegistry;
  approval?: PortApprovalBroker;
  skills?: () => Promise<SkillDefinition[]>;
  artifacts?: ArtifactStore;
  browser?: BrowserProvider;
  dispose(): Promise<void>;
}

export class RuntimeGateway {
  private runtime?: Promise<RuntimeBundle>;
  private readonly ports = new Set<RuntimePort>();
  private readonly subscriptions = new Map<
    RuntimePort,
    Map<string, { unsubscribe: () => void; previous?: ProductProjection }>
  >();

  constructor(
    private readonly createBundle: () => Promise<RuntimeBundle>,
    private readonly clock: { now(): number } = { now: () => Date.now() }
  ) {}

  connect(port: RuntimePort): () => void {
    this.ports.add(port);
    const listeners = new Map<
      string,
      { unsubscribe: () => void; previous?: ProductProjection }
    >();
    this.subscriptions.set(port, listeners);
    const onMessage = (message: RuntimeRequest | RuntimeResponse): void =>
      void this.handle(port, message as RuntimeRequest);
    const onDisconnect = (): void => {
      port.onMessage.removeListener(onMessage);
      port.onDisconnect.removeListener(onDisconnect);
      for (const subscription of listeners.values()) subscription.unsubscribe();
      listeners.clear();
      this.subscriptions.delete(port);
      this.ports.delete(port);
      void this.runtime?.then((bundle) => bundle.approval?.detach(port));
    };
    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    void this.ensureRuntime()
      .then((bundle) => bundle.approval?.attach(port))
      .catch(() => {
        // Startup failures are reported by the request that triggered them. An eager
        // failure here must not escape as an unhandled rejection and terminate the
        // MV3 service worker before it can return a useful configuration error.
      });
    return onDisconnect;
  }

  async dispose(): Promise<void> {
    for (const listeners of this.subscriptions.values()) {
      for (const subscription of listeners.values()) subscription.unsubscribe();
    }
    this.subscriptions.clear();
    this.ports.clear();
    const bundle = await this.runtime;
    await bundle?.dispose();
    this.runtime = undefined;
  }

  async forgetTab(windowId: number, tabId: string): Promise<void> {
    const bundle = await this.runtime?.catch(() => undefined);
    await bundle?.tabSessions?.forget({ windowId, tabId });
  }

  private async handle(port: RuntimePort, request: RuntimeRequest): Promise<void> {
    const requestId =
      request.requestId ??
      (request.type === 'command'
        ? request.command.commandId
        : `${request.type}_${this.clock.now()}_${Math.random().toString(36).slice(2, 8)}`);
    try {
      const bundle = await this.ensureRuntime();
      if (request.type === 'hello') {
        port.postMessage({ type: 'ready', revision: this.clock.now() });
        return;
      }
      if (request.type === 'approval_response') {
        const accepted = bundle.approval?.respond(request.approvalId, request.approved) ?? false;
        this.reply(port, requestId, accepted);
        return;
      }
      if (request.type === 'handoff_response') {
        const accepted =
          bundle.approval?.respondHandoff(request.handoffId, request.decision) ?? false;
        this.reply(port, requestId, accepted);
        return;
      }
      if (request.type === 'subscribe') {
        await this.subscribe(port, bundle.runtime, request.sessionId, requestId);
        return;
      }
      if (request.type === 'unsubscribe') {
        const subscription = this.subscriptions.get(port)?.get(request.sessionId);
        subscription?.unsubscribe();
        this.subscriptions.get(port)?.delete(request.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'command') {
        const ack = await bundle.runtime.command(request.command);
        this.reply(port, requestId, ack);
        return;
      }
      if (request.type === 'get_projection') {
        this.reply(port, requestId, await bundle.runtime.loadProjection(request.sessionId));
        return;
      }
      if (request.type === 'query_command') {
        this.reply(
          port,
          requestId,
          bundle.runtime.queryCommand(request.sessionId, request.commandId) ?? null
        );
        return;
      }
      if (request.type === 'stop_session') {
        await bundle.runtime.stop(request.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'list_sessions') {
        this.reply(port, requestId, await bundle.runtime.listSessions());
        return;
      }
      if (request.type === 'clear_history') {
        await bundle.tabSessions?.clear();
        const deleted = await bundle.runtime.deleteAllSessions();
        this.reply(port, requestId, { deleted });
        return;
      }
      if (request.type === 'delete_session') {
        await bundle.tabSessions?.releaseSession(request.sessionId);
        await bundle.runtime.deleteSession(request.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'restart_session') {
        await bundle.runtime.restart(request.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'list_skills') {
        this.reply(port, requestId, (await bundle.skills?.()) ?? []);
        return;
      }
      if (request.type === 'reload_runtime') {
        const current = await this.runtime;
        await current?.dispose();
        this.runtime = undefined;
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'read_artifact') {
        const metadata = await bundle.artifacts?.metadata(request.artifactId);
        const data = await bundle.artifacts?.read(request.artifactId);
        if (!metadata || !data) {
          throw new AgentError('ARTIFACT_NOT_FOUND', `Artifact not found: ${request.artifactId}`);
        }
        this.reply(port, requestId, {
          metadata,
          dataBase64: bytesToBase64(data),
        });
        return;
      }
      if (request.type === 'list_tabs') {
        this.reply(port, requestId, (await bundle.browser?.listTabs()) ?? []);
        return;
      }
      if (request.type === 'select_tab') {
        if (!bundle.browser) {
          throw new AgentError('BROWSER_UNAVAILABLE', 'Browser provider is unavailable');
        }
        await bundle.browser.setWorkingTab(request.sessionId, request.tabId);
        this.reply(port, requestId, true);
        return;
      }
      if (request.type === 'resolve_tab_session') {
        const tabs = bundle.tabSessions;
        if (!tabs) throw new AgentError('TAB_SESSIONS_UNAVAILABLE', 'Tab sessions are unavailable');
        const binding = await tabs.resolve({
          windowId: request.windowId,
          tabId: request.tabId,
        });
        const projection = await bundle.runtime.loadProjection(binding.sessionId);
        this.reply(port, requestId, { ...binding, projection });
        return;
      }
      if (request.type === 'create_tab_session') {
        const tabs = bundle.tabSessions;
        if (!tabs) throw new AgentError('TAB_SESSIONS_UNAVAILABLE', 'Tab sessions are unavailable');
        const binding = await tabs.create({
          windowId: request.windowId,
          tabId: request.tabId,
        });
        const projection = await bundle.runtime.loadProjection(binding.sessionId);
        this.reply(port, requestId, { ...binding, projection });
        return;
      }
      if (request.type === 'bind_tab_session') {
        const tabs = bundle.tabSessions;
        if (!tabs) throw new AgentError('TAB_SESSIONS_UNAVAILABLE', 'Tab sessions are unavailable');
        const binding = await tabs.bind(
          { windowId: request.windowId, tabId: request.tabId },
          request.sessionId
        );
        const projection = await bundle.runtime.loadProjection(binding.sessionId);
        this.reply(port, requestId, { ...binding, projection });
        return;
      }
      if (request.type === 'forget_tab_session') {
        await bundle.tabSessions?.forget({
          windowId: request.windowId,
          tabId: request.tabId,
        });
        this.reply(port, requestId, true);
        return;
      }
    } catch (error) {
      port.postMessage({
        type: 'response',
        requestId,
        ok: false,
        error: toStructuredError(error, 'RUNTIME_REQUEST_FAILED'),
      });
    }
  }

  private async subscribe(
    port: RuntimePort,
    runtime: WorkspaceRuntime,
    sessionId: string,
    requestId: string
  ): Promise<void> {
    const current = runtime.getProjection(sessionId);
    const listeners = this.subscriptions.get(port) ?? new Map();
    this.subscriptions.set(port, listeners);
    const existing = listeners.get(sessionId);
    existing?.unsubscribe();
    const subscription: { unsubscribe: () => void; previous?: ProductProjection } = {
      unsubscribe: () => undefined,
      previous: current,
    };
    subscription.unsubscribe = await runtime.subscribe(sessionId, (next) => {
      const frame = createProjectionFrame(subscription.previous, next);
      subscription.previous = next;
      port.postMessage({ type: 'projection', frame });
    });
    listeners.set(sessionId, subscription);
    port.postMessage({
      type: 'projection',
      frame: this.snapshotFrame(current),
    });
    this.reply(port, requestId, true);
  }

  private snapshotFrame(projection: ProductProjection): ProjectionFrame {
    return { type: 'snapshot', projection };
  }

  private reply(port: RuntimePort, requestId: string, data: unknown): void {
    const response: RuntimeResponse = {
      type: 'response',
      requestId,
      ok: true,
      data,
    };
    port.postMessage(response);
  }

  private async ensureRuntime(): Promise<RuntimeBundle> {
    this.runtime ??= this.createBundle().catch((error) => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}
