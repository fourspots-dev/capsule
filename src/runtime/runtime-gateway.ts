import type {
  ProjectionDelta,
  ProjectionFrame,
} from '../core/projection';
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
import type {
  WorkspaceCapsule,
  WorkspaceImportResult,
} from '../workspace/types';
import type { EvidenceRecord } from '../core/evidence-store';
import type {
  HostActionDiagnostic,
  HostActionEffect,
  HostActionReport,
  HostActionState,
} from '../platform/host-action';
import type { ToolRisk } from '../core/types';

export interface WorkspaceTransferControl {
  exportCapsule(): Promise<WorkspaceCapsule>;
  importCapsule(capsule: Uint8Array): Promise<WorkspaceImportResult>;
  serializeCapsule(): Promise<Uint8Array>;
}

export interface RuntimeActionStatus {
  id: string;
  version: string;
  title: string;
  description: string;
  sourceId: string;
  effects: HostActionEffect[];
  risk: ToolRisk;
  state: HostActionState;
  reason?: string;
  latencyMs?: number;
  limitations?: string[];
  lastOutcome?: string;
}

export interface RuntimeCapabilitySnapshot {
  actions: HostActionReport;
  evidence: EvidenceRecord[];
  actionOutcomes?: Record<string, string>;
}

export interface RuntimeCapabilityStatus {
  actions: RuntimeActionStatus[];
  diagnostics: HostActionDiagnostic[];
  evidence: EvidenceRecord[];
}

export interface RuntimeBundle {
  runtime: WorkspaceRuntime;
  extension?: RuntimeExtension;
  approval?: PortApprovalBroker;
  skills?: () => Promise<SkillDefinition[]>;
  artifacts?: ArtifactStore;
  workspaceTransfer?: WorkspaceTransferControl;
  capabilityStatus?: (
    sessionId?: string
  ) => Promise<RuntimeCapabilitySnapshot>;
  dispose(): Promise<void>;
}

interface ProjectionSubscription {
  unsubscribe(): void;
}

export class RuntimeGateway {
  private runtime?: Promise<RuntimeBundle>;
  private readonly ports = new Set<RuntimePort>();
  private readonly subscriptions = new Map<
    RuntimePort,
    Map<string, ProjectionSubscription>
  >();

  constructor(
    private readonly createBundle: () => Promise<RuntimeBundle>,
    private readonly clock: { now(): number } = { now: () => Date.now() }
  ) {}

  connect(port: RuntimePort): () => void {
    this.ports.add(port);
    const listeners = new Map<
      string,
      ProjectionSubscription
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
      if (core.type === 'serialize_capsule') {
        if (!bundle.workspaceTransfer) {
          throw new AgentError(
            'WORKSPACE_TRANSFER_UNAVAILABLE',
            'This runtime cannot export a Workspace Capsule'
          );
        }
        const bytes = await bundle.workspaceTransfer.serializeCapsule();
        this.reply(port, requestId, {
          dataBase64: bytesToBase64(bytes),
          bytes: bytes.byteLength,
        });
        return;
      }
      if (core.type === 'import_capsule') {
        if (!bundle.workspaceTransfer) {
          throw new AgentError(
            'WORKSPACE_TRANSFER_UNAVAILABLE',
            'This runtime cannot import a Workspace Capsule'
          );
        }
        this.reply(
          port,
          requestId,
          await bundle.workspaceTransfer.importCapsule(
            base64ToBytes(core.dataBase64)
          )
        );
        return;
      }
      if (core.type === 'get_capability_status') {
        if (!bundle.capabilityStatus) {
          throw new AgentError(
            'CAPABILITY_STATUS_UNAVAILABLE',
            'This runtime does not expose capability status'
          );
        }
        const snapshot = await bundle.capabilityStatus(core.sessionId);
        this.reply(port, requestId, toCapabilityStatus(snapshot));
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
    const listeners = this.subscriptions.get(port) ?? new Map();
    this.subscriptions.set(port, listeners);
    const existing = listeners.get(sessionId);
    existing?.unsubscribe();
    let pendingDeltas: ProjectionDelta[] = [];
    let pendingRevision = 0;
    let pendingEventSeq = 0;
    let baseRevision = 0;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    const changes = await runtime.subscribeChanges(
      sessionId,
      (change) => {
        pendingDeltas.push(...change.deltas);
        pendingRevision = change.revision;
        pendingEventSeq = change.eventSeq;
        if (flushTimer === undefined) {
          flushTimer = setTimeout(() => {
            flushTimer = undefined;
            flushChanges();
          }, 16);
        }
      }
    );
    if (!changes) {
      throw new AgentError('SESSION_NOT_FOUND', `Session not found: ${sessionId}`);
    }
    baseRevision = changes.initial.revision;
    const flushChanges = (): void => {
      if (!changes || pendingDeltas.length === 0) return;
      const deltas = coalesceProjectionDeltas(pendingDeltas);
      pendingDeltas = [];
      port.postMessage({
        type: 'projection',
        sessionId,
        logEpoch: changes.initial.logEpoch,
        ...(subscriptionId ? { subscriptionId } : {}),
        frame: {
          type: 'delta',
          sessionId,
          logEpoch: changes.initial.logEpoch,
          baseRevision,
          revision: pendingRevision,
          eventSeq: pendingEventSeq,
          deltas,
        },
      });
      baseRevision = pendingRevision;
    };
    const subscription: ProjectionSubscription = {
      unsubscribe: () => {
        if (flushTimer !== undefined) clearTimeout(flushTimer);
        flushTimer = undefined;
        flushChanges();
        changes.unsubscribe();
      },
    };
    listeners.set(sessionId, subscription);
    port.postMessage({
      type: 'projection',
      sessionId,
      logEpoch: changes.initial.logEpoch,
      ...(subscriptionId ? { subscriptionId } : {}),
      frame: this.snapshotFrame(changes.initial),
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

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function toCapabilityStatus(
  snapshot: RuntimeCapabilitySnapshot
): RuntimeCapabilityStatus {
  return {
    actions: snapshot.actions.inspected.map((entry) => ({
      id: entry.descriptor.id,
      version: entry.descriptor.version,
      title: entry.descriptor.title,
      description: entry.descriptor.description,
      sourceId: entry.sourceId,
      effects: [...entry.descriptor.effects],
      risk: entry.descriptor.risk,
      state: entry.probe.state,
      ...(entry.probe.reason ? { reason: entry.probe.reason } : {}),
      ...(entry.probe.latencyMs !== undefined
        ? { latencyMs: entry.probe.latencyMs }
        : {}),
      ...(entry.descriptor.limitations
        ? { limitations: [...entry.descriptor.limitations] }
        : {}),
      ...(snapshot.actionOutcomes?.[entry.descriptor.id]
        ? { lastOutcome: snapshot.actionOutcomes[entry.descriptor.id] }
        : {}),
    })),
    diagnostics: snapshot.actions.diagnostics.map((diagnostic) => ({
      ...diagnostic,
    })),
    evidence: snapshot.evidence.map((record) => structuredClone(record)),
  };
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
  'serialize_capsule',
  'import_capsule',
  'get_capability_status',
  'approval_response',
  'handoff_response',
]);

function coalesceProjectionDeltas(
  input: readonly ProjectionDelta[]
): ProjectionDelta[] {
  const output: ProjectionDelta[] = [];
  const rowDeltaIndexes = new Map<string, number>();
  let stateIndex: number | undefined;
  for (const delta of input) {
    if (delta.type === 'state.updated') {
      if (stateIndex === undefined) {
        stateIndex = output.length;
        output.push({
          type: 'state.updated',
          patch: { ...delta.patch },
        });
      } else {
        const state = output[stateIndex];
        if (state.type === 'state.updated') {
          Object.assign(state.patch, delta.patch);
        }
      }
      continue;
    }
    if (delta.type === 'row.delta') {
      const index = rowDeltaIndexes.get(delta.rowId);
      if (index === undefined) {
        rowDeltaIndexes.set(delta.rowId, output.length);
        output.push({ ...delta });
      } else {
        const previous = output[index];
        if (previous.type === 'row.delta') {
          output[index] = {
            ...previous,
            append: previous.append + delta.append,
          };
        }
      }
      continue;
    }
    output.push(delta);
  }
  return output;
}
