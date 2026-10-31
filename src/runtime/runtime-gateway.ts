import { createProjectionFrame, type ProjectionFrame } from '../core/projection';
import type { ProductProjection } from '../core/types';
import type { WorkspaceRuntime } from '../core/workspace-runtime';
import type { SkillDefinition } from '../core/extension-registry';
import type { ArtifactStore } from '../core/artifact-store';
import { AgentError, toStructuredError } from '../core/errors';
import type { PortApprovalBroker } from './approval-broker';
import type { RuntimePort, RuntimeRequest, RuntimeResponse } from './protocol';
import type {
  RuntimeExtension,
  RuntimeExtensionRequest,
} from '../platform/runtime-extension';

export interface RuntimeBundle {
  runtime: WorkspaceRuntime;
  extension?: RuntimeExtension;
  approval?: PortApprovalBroker;
  skills?: () => Promise<SkillDefinition[]>;
  artifacts?: ArtifactStore;
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
    const onMessage = (
      message: RuntimeRequest | RuntimeExtensionRequest | RuntimeResponse
    ): void =>
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

  private async handle(
    port: RuntimePort,
    request: RuntimeRequest | RuntimeExtensionRequest
  ): Promise<void> {
    const coreRequest = isCoreRuntimeRequest(request) ? request : undefined;
    const requestId =
      request.requestId ??
      (coreRequest?.type === 'command'
        ? coreRequest.command.commandId
        : `${request.type}_${this.clock.now()}_${Math.random().toString(36).slice(2, 8)}`);
    try {
      const bundle = await this.ensureRuntime();
      if (!coreRequest) {
        if (bundle.extension) {
          const result = await bundle.extension.tryHandle(request);
          if (result.handled) {
            this.reply(port, requestId, result.data);
            return;
          }
        }
        throw new AgentError(
          'RUNTIME_REQUEST_UNSUPPORTED',
          `Unsupported runtime request: ${request.type}`
        );
      }
      const core = coreRequest;
      if (core.type === 'hello') {
        port.postMessage({ type: 'ready', revision: this.clock.now() });
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'approval_response') {
        const accepted = bundle.approval?.respond(core.approvalId, core.approved) ?? false;
        this.reply(port, requestId, accepted);
        return;
      }
      if (core.type === 'handoff_response') {
        const accepted =
          bundle.approval?.respondHandoff(core.handoffId, core.decision) ?? false;
        this.reply(port, requestId, accepted);
        return;
      }
      if (core.type === 'subscribe') {
        await this.subscribe(
          port,
          bundle.runtime,
          core.sessionId,
          core.subscriptionId,
          requestId
        );
        return;
      }
      if (core.type === 'unsubscribe') {
        const subscription = this.subscriptions.get(port)?.get(core.sessionId);
        subscription?.unsubscribe();
        this.subscriptions.get(port)?.delete(core.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'command') {
        const ack = await bundle.runtime.command(core.command);
        this.reply(port, requestId, ack);
        return;
      }
      if (core.type === 'get_projection') {
        this.reply(port, requestId, await bundle.runtime.loadProjection(core.sessionId));
        return;
      }
      if (core.type === 'query_command') {
        this.reply(
          port,
          requestId,
          bundle.runtime.queryCommand(core.sessionId, core.commandId) ?? null
        );
        return;
      }
      if (core.type === 'stop_session') {
        await bundle.runtime.stop(core.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'list_sessions') {
        this.reply(port, requestId, await bundle.runtime.listSessions());
        return;
      }
      if (core.type === 'clear_history') {
        await bundle.extension?.beforeClearHistory?.();
        const deleted = await bundle.runtime.deleteAllSessions();
        this.reply(port, requestId, { deleted });
        return;
      }
      if (core.type === 'delete_session') {
        await bundle.extension?.beforeDeleteSession?.(core.sessionId);
        await bundle.runtime.deleteSession(core.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'rename_session') {
        await bundle.runtime.renameSession(core.sessionId, core.title);
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'restart_session') {
        await bundle.runtime.restart(core.sessionId);
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'list_skills') {
        this.reply(port, requestId, (await bundle.skills?.()) ?? []);
        return;
      }
      if (core.type === 'reload_runtime') {
        const current = await this.runtime;
        await current?.dispose();
        this.runtime = undefined;
        this.reply(port, requestId, true);
        return;
      }
      if (core.type === 'read_artifact') {
        const metadata = await bundle.artifacts?.metadata(core.artifactId);
        const data = await bundle.artifacts?.read(core.artifactId);
        if (!metadata || !data) {
          throw new AgentError('ARTIFACT_NOT_FOUND', `Artifact not found: ${core.artifactId}`);
        }
        this.reply(port, requestId, {
          metadata,
          dataBase64: bytesToBase64(data),
        });
        return;
      }
      throw new AgentError(
        'RUNTIME_REQUEST_UNSUPPORTED',
        `Unsupported runtime request: ${request.type}`
      );
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
    subscriptionId: string | undefined,
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
      port.postMessage({
        type: 'projection',
        sessionId,
        logEpoch: next.logEpoch,
        ...(subscriptionId ? { subscriptionId } : {}),
        frame,
      });
    });
    listeners.set(sessionId, subscription);
    port.postMessage({
      type: 'projection',
      sessionId,
      logEpoch: current.logEpoch,
      ...(subscriptionId ? { subscriptionId } : {}),
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

function isCoreRuntimeRequest(
  request: RuntimeRequest | RuntimeExtensionRequest
): request is RuntimeRequest {
  return CORE_REQUEST_TYPES.has(request.type);
}

const CORE_REQUEST_TYPES = new Set<string>([
  'hello',
  'subscribe',
  'unsubscribe',
  'command',
  'get_projection',
  'query_command',
  'stop_session',
  'list_sessions',
  'clear_history',
  'delete_session',
  'rename_session',
  'restart_session',
  'list_skills',
  'reload_runtime',
  'read_artifact',
  'approval_response',
  'handoff_response',
]);
