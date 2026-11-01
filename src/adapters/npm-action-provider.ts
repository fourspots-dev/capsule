import { AgentError } from '../core/errors';
import { LocalActionExecutor } from '../node/actions/local-action-executor';
import type {
  HostActionContext,
  HostActionDescriptor,
  HostActionResult,
  HostActionProvider,
} from '../platform/host-action';
import type { JsonValue } from '../core/types';

export interface NpmScriptActionDefinition {
  id: string;
  title: string;
  description: string;
  script: string;
  timeoutMs?: number;
}

export interface NpmActionProviderOptions {
  workspaceRoot: string;
  scripts: readonly NpmScriptActionDefinition[];
  maxOutputBytes?: number;
}

export class NpmScriptActionProvider implements HostActionProvider {
  private readonly scripts: Map<string, NpmScriptActionDefinition>;
  private readonly executor: LocalActionExecutor;

  constructor(private readonly options: NpmActionProviderOptions) {
    this.scripts = new Map();
    for (const script of options.scripts) {
      if (this.scripts.has(script.id)) {
        throw new Error(`Duplicate npm action: ${script.id}`);
      }
      this.scripts.set(script.id, script);
    }
    this.executor = new LocalActionExecutor({
      workspaceRoot: options.workspaceRoot,
      executableAllowlist: ['npm'],
      defaultTimeoutMs: 300_000,
      maxOutputBytes: options.maxOutputBytes ?? 1_000_000,
    });
  }

  async describe(): Promise<readonly HostActionDescriptor[]> {
    return [...this.scripts.values()].map((script) => ({
      id: script.id,
      version: '1.0.0',
      title: script.title,
      description: script.description,
      inputSchema: {
        type: 'object',
        properties: {},
      },
      outputSchema: {
        type: 'object',
        properties: {
          exitCode: { type: 'integer' },
          stdout: { type: 'string' },
          stderr: { type: 'string' },
          truncated: { type: 'boolean' },
        },
      },
      effects: ['execute', 'read'],
      risk: 'dangerous',
      timeoutMs: script.timeoutMs ?? 300_000,
      probe: async () => ({ state: 'available' }),
    }));
  }

  async invoke(
    actionId: string,
    _input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult> {
    const action = this.scripts.get(actionId);
    if (!action) throw new Error(`Unknown npm action: ${actionId}`);
    const result = await this.executor.execute({
      executable: 'npm',
      args: ['run', action.script],
      timeoutMs: action.timeoutMs ?? 300_000,
      signal: context.signal,
    });
    if (result.exitCode !== 0) {
      throw new AgentError(
        'ACTION_FAILED',
        `npm script ${action.script} failed with exit code ${result.exitCode}`,
        {
          details: {
            actionId,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            truncated: result.truncated,
          },
        }
      );
    }
    return {
      value: {
        actionId,
        script: action.script,
        ...result,
      },
      truncated: result.truncated,
    };
  }
}
