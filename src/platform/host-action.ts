import { AgentError } from '../core/errors';
import { validateToolInput } from '../core/tool-schema';
import type { JsonValue, ToolRisk } from '../core/types';

export type HostActionEffect = 'read' | 'write' | 'execute' | 'network';
export type HostActionState = 'available' | 'degraded' | 'unavailable';

export interface HostActionProbe {
  state: HostActionState;
  reason?: string;
  details?: JsonValue;
  latencyMs?: number;
}

export interface HostActionDescriptor {
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: JsonValue;
  outputSchema?: JsonValue;
  effects: readonly HostActionEffect[];
  risk: ToolRisk;
  workspaceBinding?: 'root' | 'fork' | 'remote';
  idempotency?: 'safe' | 'required' | 'never';
  timeoutMs?: number;
  limitations?: readonly string[];
  probe(): Promise<HostActionProbe>;
}

export interface HostActionContext {
  sessionId: string;
  taskId: string;
  requestId?: string;
  idempotencyKey?: string;
  workspaceId?: string;
  workspaceGeneration?: number;
  workspacePath?: string;
  environmentFingerprint?: string;
  signal: AbortSignal;
}

export interface HostActionArtifact {
  name: string;
  mimeType: string;
  kind: 'text' | 'image' | 'pdf' | 'log' | 'diff' | 'binary';
  data: Uint8Array;
}

export interface HostActionResult {
  value: JsonValue;
  status?: 'succeeded' | 'failed' | 'cancelled';
  durationMs?: number;
  exitCode?: number;
  truncated?: boolean;
  artifactIds?: readonly string[];
  artifacts?: readonly HostActionArtifact[];
  replayed?: boolean;
}

export interface HostActionProvider {
  describe(signal?: AbortSignal): Promise<readonly HostActionDescriptor[]>;
  invoke(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult | JsonValue>;
  cancel?(requestId: string): Promise<void>;
  dispose?(): Promise<void>;
}

export interface HostInteractiveSession {
  id: string;
  write(data: string, signal?: AbortSignal): Promise<void>;
  resize(columns: number, rows: number): Promise<void>;
  read(
    timeoutMs?: number,
    signal?: AbortSignal
  ): Promise<Array<{ type: 'data'; data: string } | { type: 'exit'; exitCode: number }>>;
  close(): Promise<void>;
}

export interface HostInteractiveActionProvider {
  open(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostInteractiveSession>;
}

export interface AvailableHostAction {
  descriptor: HostActionDescriptor;
  sourceId: string;
  probe: HostActionProbe;
}

export interface InspectedHostAction {
  descriptor: HostActionDescriptor;
  sourceId: string;
  probe: HostActionProbe;
}

export interface HostActionDiagnostic {
  actionId: string;
  sourceId: string;
  code:
    | 'ACTION_ID_INVALID'
    | 'ACTION_DUPLICATE'
    | 'ACTION_PROBE_FAILED'
    | 'ACTION_SCHEMA_INVALID'
    | 'ACTION_VERSION_INVALID'
    | 'ACTION_EFFECT_INVALID'
    | 'ACTION_RISK_INVALID'
    | 'ACTION_WORKSPACE_BINDING_INVALID'
    | 'ACTION_IDEMPOTENCY_INVALID';
  message: string;
}

export interface HostActionReport {
  available: AvailableHostAction[];
  inspected: InspectedHostAction[];
  diagnostics: HostActionDiagnostic[];
}

interface Registration {
  sourceId: string;
  provider: HostActionProvider;
}

export class HostActionRegistry {
  private readonly providers = new Map<string, Registration>();
  private readonly idempotent = new Map<string, Promise<HostActionResult>>();

  register(sourceId: string, provider: HostActionProvider): () => void {
    const normalized = sourceId.trim();
    if (!normalized) {
      throw new AgentError('ACTION_SOURCE_INVALID', 'Action source id is required');
    }
    if (this.providers.has(normalized)) {
      throw new AgentError(
        'ACTION_SOURCE_DUPLICATE',
        `Action provider is already registered: ${normalized}`
      );
    }
    this.providers.set(normalized, { sourceId: normalized, provider });
    return () => {
      if (this.providers.get(normalized)?.provider === provider) {
        this.providers.delete(normalized);
      }
    };
  }

  async discover(signal?: AbortSignal): Promise<HostActionReport> {
    throwIfAborted(signal);
    const available: AvailableHostAction[] = [];
    const inspected: InspectedHostAction[] = [];
    const diagnostics: HostActionDiagnostic[] = [];
    const seen = new Map<string, string>();

    for (const registration of [...this.providers.values()].sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    )) {
      throwIfAborted(signal);
      let descriptors: readonly HostActionDescriptor[];
      try {
        descriptors = await registration.provider.describe(signal);
      } catch (error) {
        if (signal?.aborted) throw abortError();
        diagnostics.push({
          actionId: '*',
          sourceId: registration.sourceId,
          code: 'ACTION_PROBE_FAILED',
          message: `Provider ${registration.sourceId} discovery failed: ${errorMessage(error)}`,
        });
        continue;
      }
      const localIds = new Set<string>();
      for (const descriptor of descriptors) {
        throwIfAborted(signal);
        if (!isValidActionId(descriptor.id)) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_ID_INVALID',
            message: `Invalid action id: ${String(descriptor.id)}`,
          });
          continue;
        }
        if (localIds.has(descriptor.id) || seen.has(descriptor.id)) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_DUPLICATE',
            message: `Action ${descriptor.id} is declared more than once`,
          });
          continue;
        }
        localIds.add(descriptor.id);
        seen.set(descriptor.id, registration.sourceId);
        if (!descriptor.version.trim()) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_VERSION_INVALID',
            message: `Action ${descriptor.id} must declare a version`,
          });
          continue;
        }
        if (!isObjectSchema(descriptor.inputSchema)) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_SCHEMA_INVALID',
            message: `Action ${descriptor.id} inputSchema must be an object schema`,
          });
          continue;
        }
        if (
          descriptor.outputSchema !== undefined &&
          !isObjectSchema(descriptor.outputSchema)
        ) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_SCHEMA_INVALID',
            message: `Action ${descriptor.id} outputSchema must be an object schema`,
          });
          continue;
        }
        if (
          !Array.isArray(descriptor.effects) ||
          descriptor.effects.length === 0 ||
          descriptor.effects.some(
            (effect) => !actionEffects.has(effect as HostActionEffect)
          )
        ) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_EFFECT_INVALID',
            message: `Action ${descriptor.id} must declare valid effects`,
          });
          continue;
        }
        if (!actionRisks.has(descriptor.risk)) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_RISK_INVALID',
            message: `Action ${descriptor.id} has invalid risk ${descriptor.risk}`,
          });
          continue;
        }
        if (
          descriptor.workspaceBinding !== undefined &&
          !workspaceBindings.has(descriptor.workspaceBinding)
        ) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_WORKSPACE_BINDING_INVALID',
            message: `Action ${descriptor.id} has invalid workspace binding`,
          });
          continue;
        }
        if (
          descriptor.idempotency !== undefined &&
          !idempotencyModes.has(descriptor.idempotency)
        ) {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_IDEMPOTENCY_INVALID',
            message: `Action ${descriptor.id} has invalid idempotency policy`,
          });
          continue;
        }
        let probe: HostActionProbe;
        const started = Date.now();
        try {
          probe = await descriptor.probe();
        } catch (error) {
          if (signal?.aborted) throw abortError();
          probe = {
            state: 'unavailable',
            reason: errorMessage(error),
            latencyMs: Date.now() - started,
          };
        }
        const observed = {
          descriptor,
          sourceId: registration.sourceId,
          probe: { ...probe, latencyMs: probe.latencyMs ?? Date.now() - started },
        };
        inspected.push(observed);
        if (probe.state !== 'available') {
          diagnostics.push({
            actionId: descriptor.id,
            sourceId: registration.sourceId,
            code: 'ACTION_PROBE_FAILED',
            message:
              probe.reason ??
              `Action ${descriptor.id} probe is ${probe.state}`,
          });
          continue;
        }
        available.push({
          ...observed,
        });
      }
    }

    return {
      available: available.sort((a, b) =>
        a.descriptor.id.localeCompare(b.descriptor.id)
      ),
      inspected: inspected.sort((a, b) =>
        a.descriptor.id.localeCompare(b.descriptor.id)
      ),
      diagnostics,
    };
  }

  async invoke(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult> {
    throwIfAborted(context.signal);
    const started = Date.now();
    const report = await this.discover(context.signal);
    const action = report.available.find(
      (candidate) => candidate.descriptor.id === actionId
    );
    if (!action) {
      throw new AgentError(
        'ACTION_UNAVAILABLE',
        `Application action is unavailable: ${actionId}`
      );
    }
    const registration = this.providers.get(action.sourceId);
    if (!registration) {
      throw new AgentError(
        'ACTION_UNAVAILABLE',
        `Application action provider disappeared: ${action.sourceId}`
      );
    }
    try {
      validateToolInput(
        action.descriptor.inputSchema as Record<string, JsonValue>,
        input as Record<string, JsonValue>
      );
    } catch (error) {
      throw new AgentError(
        'ACTION_INPUT_INVALID',
        error instanceof Error ? error.message : String(error)
      );
    }
    try {
      const cacheKey =
        action.descriptor.idempotency === 'required'
          ? idempotencyCacheKey(action, input, context)
          : undefined;
      let result: HostActionResult | JsonValue;
      if (cacheKey) {
        const existing = this.idempotent.get(cacheKey);
        if (existing) {
          return { ...(await existing), replayed: true };
        }
        const invocation = registration.provider.invoke(
          actionId,
          input,
          { ...context, idempotencyKey: cacheKey }
        );
        const promise = invocation.then((value) => {
          const normalized = isActionResult(value) ? value : { value };
          return {
            ...normalized,
            status: normalized.status ?? ('succeeded' as const),
            durationMs: normalized.durationMs ?? Date.now() - started,
          };
        });
        this.idempotent.set(cacheKey, promise);
        try {
          result = await promise;
        } catch (error) {
          this.idempotent.delete(cacheKey);
          throw error;
        }
      } else {
        result = await registration.provider.invoke(
          actionId,
          input,
          context
        );
      }
      throwIfAborted(context.signal);
      const normalized = isActionResult(result) ? result : { value: result };
      return {
        ...normalized,
        status: normalized.status ?? 'succeeded',
        durationMs: normalized.durationMs ?? Date.now() - started,
      };
    } catch (error) {
      if (context.signal.aborted) {
        throw new AgentError(
          'ACTION_CANCELLED',
          `Application Action was cancelled: ${actionId}`
        );
      }
      if (error instanceof AgentError) throw error;
      throw new AgentError(
        'ACTION_PROVIDER_CRASHED',
        error instanceof Error ? error.message : String(error),
        { details: { actionId, sourceId: action.sourceId } }
      );
    }
  }

  async list(): Promise<AvailableHostAction[]> {
    return (await this.discover()).available;
  }

  async cancel(requestId: string): Promise<void> {
    for (const provider of this.providers.values()) {
      await provider.provider.cancel?.(requestId);
    }
  }

  async dispose(): Promise<void> {
    const providers = [...this.providers.values()];
    this.providers.clear();
    this.idempotent.clear();
    await Promise.allSettled(
      providers.map((provider) => provider.provider.dispose?.())
    );
  }
}

export function toolNameForAction(actionId: string): string {
  return `action_${actionId.replace(/[^A-Za-z0-9_]/g, '_')}`;
}

function isValidActionId(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(value);
}

function isObjectSchema(value: JsonValue): boolean {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.type === 'object'
  );
}

function isActionResult(value: HostActionResult | JsonValue): value is HostActionResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'value' in value
  );
}

const actionEffects = new Set<HostActionEffect>([
  'read',
  'write',
  'execute',
  'network',
]);
const actionRisks = new Set<ToolRisk>(['read', 'write', 'dangerous']);
const workspaceBindings = new Set(['root', 'fork', 'remote']);
const idempotencyModes = new Set(['safe', 'required', 'never']);

function idempotencyCacheKey(
  action: AvailableHostAction,
  input: JsonValue,
  context: HostActionContext
): string {
  return [
    action.sourceId,
    action.descriptor.id,
    action.descriptor.version,
    context.sessionId,
    context.taskId,
    context.workspaceId ?? '',
    context.workspaceGeneration ?? '',
    context.environmentFingerprint ?? '',
    context.idempotencyKey ?? '',
    JSON.stringify(input),
  ].join(':');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  const error = new Error('Action discovery was cancelled');
  error.name = 'AbortError';
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
