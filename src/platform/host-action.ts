import { AgentError } from '../core/errors';
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
  timeoutMs?: number;
  limitations?: readonly string[];
  probe(): Promise<HostActionProbe>;
}

export interface HostActionContext {
  sessionId: string;
  taskId: string;
  workspacePath?: string;
  signal: AbortSignal;
}

export interface HostActionResult {
  value: JsonValue;
  truncated?: boolean;
  artifactIds?: readonly string[];
}

export interface HostActionProvider {
  describe(signal?: AbortSignal): Promise<readonly HostActionDescriptor[]>;
  invoke(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult | JsonValue>;
}

export interface AvailableHostAction {
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
    | 'ACTION_VERSION_INVALID';
  message: string;
}

export interface HostActionReport {
  available: AvailableHostAction[];
  diagnostics: HostActionDiagnostic[];
}

interface Registration {
  sourceId: string;
  provider: HostActionProvider;
}

export class HostActionRegistry {
  private readonly providers = new Map<string, Registration>();

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
          descriptor,
          sourceId: registration.sourceId,
          probe: { ...probe, latencyMs: probe.latencyMs ?? Date.now() - started },
        });
      }
    }

    return {
      available: available.sort((a, b) =>
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
    const result = await registration.provider.invoke(
      actionId,
      input,
      context
    );
    return isActionResult(result) ? result : { value: result };
  }

  async list(): Promise<AvailableHostAction[]> {
    return (await this.discover()).available;
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
