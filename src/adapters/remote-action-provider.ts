import { AgentError } from '../core/errors';
import type { JsonValue } from '../core/types';
import type {
  HostActionContext,
  HostActionDescriptor,
  HostActionEffect,
  HostActionProbe,
  HostActionResult,
  HostActionProvider,
} from '../platform/host-action';

interface RemoteActionDescriptor {
  id: string;
  version: string;
  title: string;
  description: string;
  inputSchema: JsonValue;
  outputSchema?: JsonValue;
  effects: HostActionEffect[];
  risk: 'read' | 'write' | 'dangerous';
  workspaceBinding?: 'root' | 'fork' | 'remote';
  timeoutMs?: number;
  limitations?: string[];
  probe?: HostActionProbe;
}

interface RemoteActionResponse {
  status: 'succeeded' | 'failed' | 'cancelled';
  value: JsonValue;
  exitCode?: number;
  truncated?: boolean;
  artifactIds?: string[];
}

export interface RemoteActionProviderOptions {
  endpoint: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

/**
 * Remote Action client using the same descriptor and result contract as local
 * and native Providers. It never accepts a raw command field.
 */
export class RemoteActionProvider implements HostActionProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: RemoteActionProviderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async describe(signal?: AbortSignal): Promise<readonly HostActionDescriptor[]> {
    const response = await this.request(
      { type: 'describe' },
      signal
    );
    if (!Array.isArray(response.actions)) {
      throw new AgentError(
        'REMOTE_ACTION_RESPONSE_INVALID',
        'Remote Action describe response is missing actions'
      );
    }
    return response.actions.map((action) =>
      remoteDescriptor(validateDescriptor(action))
    );
  }

  async invoke(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult> {
    const response = await this.request(
      {
        type: 'invoke',
        actionId,
        input,
        context: {
          sessionId: context.sessionId,
          taskId: context.taskId,
          requestId: context.requestId,
          workspaceId: context.workspaceId,
          workspaceGeneration: context.workspaceGeneration,
          environmentFingerprint: context.environmentFingerprint,
        },
      },
      context.signal
    );
    if (!isRemoteResult(response.result)) {
      throw new AgentError(
        'ACTION_RESULT_INVALID',
        `Remote Action ${actionId} returned an invalid result`
      );
    }
    return response.result;
  }

  async cancel(requestId: string): Promise<void> {
    await this.request({ type: 'cancel', requestId });
  }

  private async request(
    payload: unknown,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    if (signal?.aborted) {
      throw new AgentError('ACTION_CANCELLED', 'Remote Action was cancelled');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.token
            ? { authorization: `Bearer ${this.options.token}` }
            : {}),
          ...this.options.headers,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new AgentError(
          'REMOTE_ACTION_HTTP_ERROR',
          `Remote Action endpoint returned HTTP ${response.status}`
        );
      }
      const body = (await response.json()) as unknown;
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new AgentError(
          'REMOTE_ACTION_RESPONSE_INVALID',
          'Remote Action response must be an object'
        );
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (signal?.aborted) {
        throw new AgentError('ACTION_CANCELLED', 'Remote Action was cancelled');
      }
      if (controller.signal.aborted) {
        throw new AgentError('ACTION_TIMEOUT', 'Remote Action timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
  }
}

function validateDescriptor(value: unknown): RemoteActionDescriptor {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as RemoteActionDescriptor).id !== 'string' ||
    typeof (value as RemoteActionDescriptor).version !== 'string' ||
    typeof (value as RemoteActionDescriptor).title !== 'string' ||
    typeof (value as RemoteActionDescriptor).description !== 'string'
  ) {
    throw new AgentError(
      'REMOTE_ACTION_RESPONSE_INVALID',
      'Remote Action descriptor is invalid'
    );
  }
  return value as RemoteActionDescriptor;
}

function remoteDescriptor(value: RemoteActionDescriptor): HostActionDescriptor {
  return {
    id: value.id,
    version: value.version,
    title: value.title,
    description: value.description,
    inputSchema: value.inputSchema,
    ...(value.outputSchema ? { outputSchema: value.outputSchema } : {}),
    effects: value.effects,
    risk: value.risk,
    ...(value.workspaceBinding
      ? { workspaceBinding: value.workspaceBinding }
      : {}),
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    ...(value.limitations ? { limitations: value.limitations } : {}),
    probe: async () => value.probe ?? { state: 'available' },
  };
}

function isRemoteResult(value: unknown): value is HostActionResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      ['succeeded', 'failed', 'cancelled'].includes(
        (value as RemoteActionResponse).status
      ) &&
      'value' in value
  );
}
