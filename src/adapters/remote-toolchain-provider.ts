import { AgentError } from '../core/errors';
import {
  parseWorkspaceBundle,
  serializeWorkspaceBundle,
  type VirtualCommandProvider,
  type VirtualCommandRequest,
  type VirtualCommandResult,
  type VirtualFileSystem,
  type WorkspaceBundle,
} from '../virtual';
import { exportWorkspaceBundle, importWorkspaceBundle } from '../virtual/workspace';

export interface RemoteToolchainProviderOptions {
  endpoint: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  workspace: VirtualFileSystem;
  timeoutMs?: number;
  commandAllowlist?: readonly string[];
}

interface RemoteRunnerResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
  workspace?: WorkspaceBundle;
  revision?: string;
}

/**
 * Sends the virtual project bundle to a remote runner, executes a command in
 * its synced copy, and applies the returned bundle only after a valid response.
 */
export class RemoteToolchainProvider implements VirtualCommandProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly allowlist?: Set<string>;

  constructor(private readonly options: RemoteToolchainProviderOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.allowlist = options.commandAllowlist
      ? new Set(options.commandAllowlist)
      : undefined;
  }

  canExecute(command: string): boolean {
    return !this.allowlist || this.allowlist.has(command);
  }

  async execute(request: VirtualCommandRequest): Promise<VirtualCommandResult> {
    if (!this.canExecute(request.command)) {
      throw new AgentError(
        'REMOTE_COMMAND_DENIED',
        `Remote command is not allowlisted: ${request.command}`
      );
    }
    const workspace = await exportWorkspaceBundle(this.options.workspace, {
      metadata: { source: 'tinyai-remote-runner' },
    });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? 300_000
    );
    const abort = () => controller.abort();
    request.signal?.addEventListener('abort', abort, { once: true });
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
        body: JSON.stringify({
          command: request.command,
          args: request.args,
          cwd: request.cwd,
          env: request.env,
          stdin: request.stdin,
          workspace,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 500);
        throw new AgentError(
          'REMOTE_RUNNER_HTTP_ERROR',
          `Remote runner HTTP ${response.status}${detail ? `: ${detail}` : ''}`
        );
      }
      const result = (await response.json()) as RemoteRunnerResponse;
      validateResult(result);
      if (result.workspace) {
        const parsed = parseWorkspaceBundle(result.workspace);
        await importWorkspaceBundle(this.options.workspace, parsed, {
          replace: true,
        });
      }
      return {
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error) {
      if (request.signal?.aborted) {
        throw new AgentError('REMOTE_RUNNER_ABORTED', 'Remote command was cancelled');
      }
      if (controller.signal.aborted) {
        throw new AgentError('REMOTE_RUNNER_TIMEOUT', 'Remote command timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener('abort', abort);
    }
  }

  encodeWorkspace(workspace: WorkspaceBundle): Uint8Array {
    return serializeWorkspaceBundle(workspace);
  }
}

function validateResult(value: unknown): asserts value is RemoteRunnerResponse {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    typeof (value as RemoteRunnerResponse).exitCode !== 'number' ||
    typeof (value as RemoteRunnerResponse).stdout !== 'string' ||
    typeof (value as RemoteRunnerResponse).stderr !== 'string'
  ) {
    throw new AgentError(
      'REMOTE_RUNNER_RESPONSE_INVALID',
      'Remote runner returned an invalid response'
    );
  }
}
