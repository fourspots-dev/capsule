import type {
  CodeDiagnostic,
  CodeIntelligenceCapabilities,
  CodeIntelligencePort,
  CodeRange,
  SymbolInfo,
  SymbolLocation,
  WorkspaceEditAction,
} from '../platform/code-intelligence';
import type { VirtualFileSystem } from '../virtual';

const SOURCE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'java',
  'kt',
  'swift',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
]);
const MAX_FILE_BYTES = 512 * 1024;

interface IndexedFile {
  path: string;
  text: string;
}

export class TextCodeIntelligence implements CodeIntelligencePort {
  constructor(private readonly vfs: VirtualFileSystem) {}

  async capabilities(): Promise<CodeIntelligenceCapabilities> {
    return {
      provider: 'text',
      diagnostics: false,
      symbols: true,
      definitions: true,
      references: true,
      codeActions: false,
      limitations: [
        'Text fallback cannot provide semantic diagnostics or code actions',
        'Definitions and references are lexical matches, not compiler-resolved',
      ],
    };
  }

  async diagnostics(
    _paths: readonly string[],
    _signal?: AbortSignal
  ): Promise<CodeDiagnostic[]> {
    return [];
  }

  async symbols(
    query: string,
    signal?: AbortSignal
  ): Promise<SymbolInfo[]> {
    const needle = query.trim().toLowerCase();
    const result: SymbolInfo[] = [];
    for (const file of await this.index(signal)) {
      for (const symbol of extractSymbols(file)) {
        if (!needle || symbol.name.toLowerCase().includes(needle)) {
          result.push(symbol);
        }
      }
    }
    return result.slice(0, 500);
  }

  async definition(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]> {
    return this.findMatches(symbol, signal, true);
  }

  async references(
    symbol: string,
    signal?: AbortSignal
  ): Promise<SymbolLocation[]> {
    return this.findMatches(symbol, signal, false);
  }

  async codeActions(
    _path: string,
    _range: CodeRange,
    _signal?: AbortSignal
  ): Promise<WorkspaceEditAction[]> {
    return [];
  }

  private async findMatches(
    symbol: string,
    signal: AbortSignal | undefined,
    definitionsOnly: boolean
  ): Promise<SymbolLocation[]> {
    const needle = symbol.trim();
    if (!needle) return [];
    const expression = new RegExp(
      `\\b${escapeRegex(needle)}\\b`,
      'g'
    );
    const result: SymbolLocation[] = [];
    for (const file of await this.index(signal)) {
      const lines = file.text.split('\n');
      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = lines[lineIndex];
        for (const match of line.matchAll(expression)) {
          if (
            definitionsOnly &&
            !isDefinitionLine(line, needle)
          ) {
            continue;
          }
          const column = (match.index ?? 0) + 1;
          result.push({
            path: file.path,
            symbol: needle,
            range: {
              startLine: lineIndex + 1,
              startColumn: column,
              endLine: lineIndex + 1,
              endColumn: column + needle.length,
            },
          });
          if (result.length >= 1_000) return result;
        }
      }
    }
    return result;
  }

  private async index(signal?: AbortSignal): Promise<IndexedFile[]> {
    const files: IndexedFile[] = [];
    for (const entry of await this.vfs.list('', {
      recursive: true,
      signal,
    })) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (entry.kind !== 'file' || entry.size > MAX_FILE_BYTES) continue;
      const extension = entry.path.split('.').at(-1)?.toLowerCase();
      if (!extension || !SOURCE_EXTENSIONS.has(extension)) continue;
      try {
        files.push({
          path: entry.path,
          text: new TextDecoder('utf-8', { fatal: false }).decode(
            await this.vfs.read(entry.path, { signal })
          ),
        });
      } catch {
        // Binary or unreadable files are outside the text fallback index.
      }
    }
    return files;
  }
}

function extractSymbols(file: IndexedFile): SymbolInfo[] {
  const result: SymbolInfo[] = [];
  const expression =
    /\b(?:export\s+)?(?:async\s+)?(class|interface|type|enum|function|const|let|var|def|struct)\s+([A-Za-z_$][\w$]*)/g;
  const lines = file.text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    for (const match of lines[index].matchAll(expression)) {
      const column = (match.index ?? 0) + 1;
      result.push({
        name: match[2],
        kind: match[1],
        path: file.path,
        range: {
          startLine: index + 1,
          startColumn: column,
          endLine: index + 1,
          endColumn: column + match[0].length,
        },
      });
    }
  }
  return result;
}

function isDefinitionLine(line: string, symbol: string): boolean {
  return new RegExp(
    `\\b(?:class|interface|type|enum|function|const|let|var|def|struct)\\s+${escapeRegex(symbol)}\\b`
  ).test(line);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
