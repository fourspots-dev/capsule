import type { JsonValue } from '../core/types';
import { AgentError } from '../core/errors';
import type { HostActionRegistry } from '../platform/host-action';
import type {
  CodeDiagnostic,
  CodeIntelligenceCapabilities,
  CodeIntelligencePort,
  CodeRange,
  SymbolInfo,
  SymbolLocation,
  WorkspaceEditAction,
} from '../platform/code-intelligence';

export interface LspActionCodeIntelligenceOptions {
  actionId?: string;
  sessionId?: string;
  taskId?: string;
}

/**
 * Maps a named, application-provided Action to the language-neutral semantic
 * code intelligence port. No language server binary is assumed by Core.
 */
export class LspActionCodeIntelligence implements CodeIntelligencePort {
  private readonly actionId: string;
  private readonly sessionId: string;
  private readonly taskId: string;

  constructor(
    private readonly registry: HostActionRegistry,
    options: LspActionCodeIntelligenceOptions = {}
  ) {
    this.actionId = options.actionId ?? 'code.lsp.query';
    this.sessionId = options.sessionId ?? 'code-intelligence';
    this.taskId = options.taskId ?? 'code-intelligence';
  }

  async capabilities(): Promise<CodeIntelligenceCapabilities> {
    const action = (await this.registry.list()).find(
      (candidate) => candidate.descriptor.id === this.actionId
    );
    return {
      provider: 'lsp',
      diagnostics: Boolean(action),
      symbols: Boolean(action),
      definitions: Boolean(action),
      references: Boolean(action),
      codeActions: Boolean(action),
      limitations: action
        ? []
        : [`Action ${this.actionId} is unavailable; use text fallback`],
    };
  }

  async diagnostics(
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<CodeDiagnostic[]> {
    return parseArray<CodeDiagnostic>(
      await this.query({ operation: 'diagnostics', paths: [...paths] }, signal),
      'diagnostics'
    );
  }

  async symbols(
    query: string,
    signal?: AbortSignal
  ): Promise<SymbolInfo[]> {
    return parseArray<SymbolInfo>(
      await this.query({ operation: 'symbols', query }, signal),
      'symbols'
    );
  }

  async definition(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]> {
    return parseArray<SymbolLocation>(
      await this.query({ operation: 'definition', symbol }, signal),
      'locations'
    );
  }

  async references(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]> {
    return parseArray<SymbolLocation>(
      await this.query({ operation: 'references', symbol }, signal),
      'locations'
    );
  }

  async codeActions(
    path: string,
    range: CodeRange,
    signal?: AbortSignal
  ): Promise<WorkspaceEditAction[]> {
    return parseArray<WorkspaceEditAction>(
      await this.query(
        { operation: 'codeActions', path, range } as unknown as JsonValue,
        signal
      ),
      'actions'
    );
  }

  private async query(
    input: JsonValue,
    signal: AbortSignal = new AbortController().signal
  ): Promise<JsonValue> {
    const available = (await this.registry.list()).some(
      (action) => action.descriptor.id === this.actionId
    );
    if (!available) {
      throw new AgentError(
        'CODE_INTELLIGENCE_UNAVAILABLE',
        `LSP Action is unavailable: ${this.actionId}`
      );
    }
    return (
      await this.registry.invoke(this.actionId, input, {
        sessionId: this.sessionId,
        taskId: this.taskId,
        signal,
      })
    ).value;
  }
}

function parseArray<T>(value: JsonValue, key: string): T[] {
  if (Array.isArray(value)) return value as unknown as T[];
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate as unknown as T[];
  }
  throw new AgentError(
    'CODE_INTELLIGENCE_RESULT_INVALID',
    `LSP Action result must contain ${key}`
  );
}
