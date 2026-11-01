export interface CodeRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

export interface SymbolLocation {
  path: string;
  range: CodeRange;
  symbol: string;
}

export interface CodeDiagnostic {
  path: string;
  range?: CodeRange;
  severity: 'error' | 'warning' | 'info' | 'hint';
  code?: string;
  message: string;
}

export interface SymbolInfo {
  name: string;
  kind: string;
  path: string;
  range: CodeRange;
  container?: string;
}

export interface WorkspaceTextEdit {
  path: string;
  range: CodeRange;
  newText: string;
}

export interface WorkspaceEditAction {
  title: string;
  kind: string;
  edits: WorkspaceTextEdit[];
}

export interface CodeIntelligenceCapabilities {
  provider: 'lsp' | 'text';
  diagnostics: boolean;
  symbols: boolean;
  definitions: boolean;
  references: boolean;
  codeActions: boolean;
  limitations: string[];
}

export interface CodeIntelligencePort {
  capabilities(): Promise<CodeIntelligenceCapabilities>;
  diagnostics(
    paths: readonly string[],
    signal?: AbortSignal
  ): Promise<CodeDiagnostic[]>;
  symbols(query: string, signal?: AbortSignal): Promise<SymbolInfo[]>;
  definition(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]>;
  references(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]>;
  codeActions(
    path: string,
    range: CodeRange,
    signal?: AbortSignal
  ): Promise<WorkspaceEditAction[]>;
}

export class UnavailableCodeIntelligence implements CodeIntelligencePort {
  async capabilities(): Promise<CodeIntelligenceCapabilities> {
    return {
      provider: 'text',
      diagnostics: false,
      symbols: false,
      definitions: false,
      references: false,
      codeActions: false,
      limitations: ['Code intelligence is unavailable'],
    };
  }

  async diagnostics(): Promise<CodeDiagnostic[]> {
    throw unavailable();
  }

  async symbols(): Promise<SymbolInfo[]> {
    throw unavailable();
  }

  async definition(): Promise<SymbolLocation[]> {
    throw unavailable();
  }

  async references(): Promise<SymbolLocation[]> {
    throw unavailable();
  }

  async codeActions(): Promise<WorkspaceEditAction[]> {
    throw unavailable();
  }
}

function unavailable(): Error {
  return new Error('Code intelligence is unavailable');
}
