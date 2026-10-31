import { AgentError } from '../core/errors';
import {
  normalizeVirtualPath,
  parentVirtualPath,
} from './path';
import type { VirtualFileInfo, VirtualFileSystem } from './types';
import { unifiedDiff } from './vcs';
import { applyUnifiedPatch } from './patch';

export interface VirtualCommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  stdin: string;
  signal?: AbortSignal;
}

export interface VirtualCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface VirtualCommandProvider {
  canExecute(command: string): boolean;
  execute(request: VirtualCommandRequest): Promise<VirtualCommandResult>;
}

export interface VirtualShellOptions {
  cwd?: string;
  env?: Record<string, string>;
  providers?: VirtualCommandProvider[];
  maxOutputChars?: number;
}

interface ParsedCommand {
  args: string[];
  redirectOut?: { path: string; append: boolean };
  redirectIn?: string;
  assignments: Record<string, string>;
}

export class VirtualShell {
  private readonly providers: VirtualCommandProvider[];
  private readonly maxOutputChars: number;
  private cwd: string;
  private env: Record<string, string>;
  private lastExitCode = 0;

  constructor(
    private readonly vfs: VirtualFileSystem,
    options: VirtualShellOptions = {}
  ) {
    this.cwd = normalizeVirtualPath(options.cwd ?? '');
    this.env = { ...(options.env ?? {}) };
    this.providers = [...(options.providers ?? [])];
    this.maxOutputChars = options.maxOutputChars ?? 1_000_000;
  }

  get currentDirectory(): string {
    return this.cwd;
  }

  get environment(): Readonly<Record<string, string>> {
    return { ...this.env };
  }

  addProvider(provider: VirtualCommandProvider): () => void {
    this.providers.push(provider);
    return () => {
      const index = this.providers.indexOf(provider);
      if (index >= 0) this.providers.splice(index, 1);
    };
  }

  async execute(
    script: string,
    options: { signal?: AbortSignal; stdin?: string } = {}
  ): Promise<VirtualCommandResult> {
    assertSupportedSyntax(script);
    const logicalParts = splitOutsideQuotes(script, ['&&', '||', ';']);
    const logical = logicalParts.map((item) => ({
      value: item.value,
      operator: item.operator,
    }));
    let stdin = options.stdin ?? '';
    let stdout = '';
    let stderr = '';
    for (const item of logical) {
      if (!item.value.trim()) continue;
      const shouldRun =
        item.operator === ';' ||
        (item.operator === '&&' && this.lastExitCode === 0) ||
        (item.operator === '||' && this.lastExitCode !== 0) ||
        item.operator === undefined;
      if (!shouldRun) continue;
      const pipeline = await this.runPipeline(item.value.trim(), stdin, options.signal);
      stdout += pipeline.stdout;
      stderr += pipeline.stderr;
      stdin = pipeline.stdout;
      this.lastExitCode = pipeline.exitCode;
    }
    return {
      exitCode: this.lastExitCode,
      stdout: truncate(stdout, this.maxOutputChars),
      stderr: truncate(stderr, this.maxOutputChars),
    };
  }

  private async runPipeline(
    chain: string,
    initialStdin: string,
    signal?: AbortSignal
  ): Promise<VirtualCommandResult> {
    const commands = splitOutsideQuotes(chain, ['|'])
      .filter((item) => item.value.trim())
      .map((item) => item.value.trim());
    let stdin = initialStdin;
    let stdout = '';
    let stderr = '';
    let exitCode = 0;
    for (const command of commands) {
      if (signal?.aborted) {
        throw new AgentError('SHELL_ABORTED', 'Virtual shell command was cancelled');
      }
      const parsed = parseCommand(tokenize(command), this.env, this.lastExitCode);
      if (!parsed.args.length) {
        Object.assign(this.env, parsed.assignments);
        continue;
      }
      if (parsed.redirectIn) {
        stdin = decode(await this.vfs.read(this.resolve(parsed.redirectIn), { signal }));
      }
      let result: VirtualCommandResult;
      if (BUILTINS.has(parsed.args[0])) {
        result = await this.runBuiltin(parsed.args[0], parsed.args.slice(1), stdin, {
          ...this.env,
          ...parsed.assignments,
        }, signal);
      } else {
        const provider = this.providers.find((item) =>
          item.canExecute(parsed.args[0])
        );
        result = provider
          ? await provider.execute({
              command: parsed.args[0],
              args: parsed.args.slice(1),
              cwd: this.cwd,
              env: { ...this.env, ...parsed.assignments },
              stdin,
              signal,
            })
          : {
              exitCode: 127,
              stdout: '',
              stderr: `${parsed.args[0]}: command not found\n`,
            };
      }
      stdout = result.stdout;
      stderr += result.stderr;
      exitCode = result.exitCode;
      if (parsed.redirectOut) {
        const redirectPath = this.resolve(parsed.redirectOut.path);
        const previous = parsed.redirectOut.append
          ? decode(await this.vfs.read(redirectPath, { signal }).catch(() => new Uint8Array()))
          : '';
        await this.vfs.write(
          redirectPath,
          encode(previous + result.stdout),
          { signal }
        );
        stdout = '';
      }
      stdin = result.stdout;
    }
    return { exitCode, stdout, stderr };
  }

  private async runBuiltin(
    command: string,
    args: string[],
    stdin: string,
    env: Record<string, string>,
    signal?: AbortSignal
  ): Promise<VirtualCommandResult> {
    const ok = (stdout = ''): VirtualCommandResult => ({ exitCode: 0, stdout, stderr: '' });
    const fail = (stderr: string, exitCode = 1): VirtualCommandResult => ({
      exitCode,
      stdout: '',
      stderr: `${stderr}\n`,
    });
    if (command === 'true') return ok();
    if (command === 'false') return fail('', 1);
    if (command === 'pwd') return ok(`${this.cwd || '.'}\n`);
    if (command === 'echo') return ok(`${args.join(' ')}\n`);
    if (command === 'env') {
      return ok(
        Object.entries(env)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, value]) => `${key}=${value}`)
          .join('\n') + '\n'
      );
    }
    if (command === 'export') {
      for (const item of args) {
        const [key, ...value] = item.split('=');
        if (key && value.length) this.env[key] = value.join('=');
      }
      return ok();
    }
    if (command === 'cd') {
      const target = args[0] ?? '';
      const next = normalizeVirtualPath(
        target.startsWith('/')
          ? target
          : `${this.cwd}${this.cwd && target ? '/' : ''}${target}`
      );
      if (next && (await this.vfs.stat(next, signal))?.kind !== 'directory') {
        return fail(`cd: no such directory: ${target}`);
      }
      this.cwd = next;
      return ok();
    }
    if (command === 'ls') {
      const recursive = args.includes('-R');
      const pathArg = args.find((item) => !item.startsWith('-')) ?? this.cwd;
      const items = await this.vfs.list(pathArg, { recursive, signal });
      const prefix = normalizeVirtualPath(pathArg);
      return ok(
        items
          .map((item) => {
            const relative = prefix
              ? item.path.slice(prefix.length + 1)
              : item.path;
            return item.kind === 'directory' ? `${relative}/` : relative;
          })
          .join('\n') + (items.length ? '\n' : '')
      );
    }
    if (command === 'cat') {
      if (!args.length) return ok(stdin);
      const output: string[] = [];
      for (const path of args) {
        output.push(decode(await this.vfs.read(this.resolve(path), { signal })));
      }
      return ok(output.join(''));
    }
    if (command === 'mkdir') {
      const recursive = args.includes('-p');
      const paths = args.filter((item) => item !== '-p');
      for (const path of paths) await this.vfs.mkdir(this.resolve(path), { recursive });
      return ok();
    }
    if (command === 'rm') {
      const recursive = args.includes('-r') || args.includes('-rf');
      const paths = args.filter((item) => !item.startsWith('-'));
      for (const path of paths) await this.vfs.remove(this.resolve(path), { recursive });
      return ok();
    }
    if (command === 'cp' || command === 'mv') {
      if (args.length !== 2) return fail(`${command}: source and destination required`);
      const from = this.resolve(args[0]);
      const to = this.resolve(args[1]);
      if (command === 'cp') await this.vfs.copy(from, to);
      else await this.vfs.rename(from, to);
      return ok();
    }
    if (command === 'grep' || command === 'rg') {
      if (!args.length) return fail(`${command}: pattern required`);
      const pattern = args[0];
      const paths = args.slice(1);
      if (!paths.length && stdin) {
        const output = stdin
          .split('\n')
          .map((line, index) => ({ line, index }))
          .filter(({ line }) => line.includes(pattern))
          .map(({ line, index }) => `${index + 1}:${line}`);
        return {
          exitCode: output.length ? 0 : 1,
          stdout: output.length ? `${output.join('\n')}\n` : '',
          stderr: '',
        };
      }
      const files = paths.length
        ? paths.map((path) => this.resolve(path))
        : (await this.vfs.list('', { recursive: true, signal }))
            .filter((item) => item.kind === 'file')
            .map((item) => item.path);
      const output: string[] = [];
      for (const path of files) {
        const lines = decode(await this.vfs.read(path, { signal })).split('\n');
        for (let index = 0; index < lines.length; index += 1) {
          if (lines[index].includes(pattern)) {
            output.push(`${paths.length > 1 ? `${path}:` : ''}${index + 1}:${lines[index]}`);
          }
        }
      }
      return { exitCode: output.length ? 0 : 1, stdout: output.length ? `${output.join('\n')}\n` : '', stderr: '' };
    }
    if (command === 'find') {
      const path = this.resolve(args[0] ?? '');
      return ok(
        (await this.vfs.list(path, { recursive: true, signal }))
          .map((item) => item.path)
          .sort()
          .join('\n') + '\n'
      );
    }
    if (command === 'diff') {
      if (args.length !== 2) return fail('diff: two files required');
      const before = await this.vfs.read(this.resolve(args[0]), { signal });
      const after = await this.vfs.read(this.resolve(args[1]), { signal });
      const result = unifiedDiff(before, after, `${args[0]} -> ${args[1]}`);
      return {
        exitCode: result.patch ? 1 : 0,
        stdout: result.patch ?? (result.status === 'binary' ? 'Binary files differ\n' : ''),
        stderr: '',
      };
    }
    if (command === 'patch') {
      const source = args[0] && args[0] !== '-'
        ? decode(await this.vfs.read(this.resolve(args[0]), { signal }))
        : stdin;
      if (!source.trim()) return fail('patch: input is required');
      try {
        const result = await applyUnifiedPatch(this.vfs, source, { signal });
        return ok(
          `patched ${result.files.length} file(s) (+${result.additions}/-${result.deletions})\n`
        );
      } catch (error) {
        return fail(
          error instanceof Error ? `patch: ${error.message}` : 'patch: failed'
        );
      }
    }
    if (command === 'test') {
      return args[0] === '-e' && args[1] && (await this.vfs.stat(this.resolve(args[1]), signal))
        ? ok()
        : fail('', 1);
    }
    return fail(`${command}: builtin not implemented`, 127);
  }

  private resolve(path: string): string {
    if (path.startsWith('/')) return normalizeVirtualPath(path);
    return normalizeVirtualPath(`${this.cwd}${this.cwd && path ? '/' : ''}${path}`);
  }
}

const BUILTINS = new Set([
  'true',
  'false',
  'pwd',
  'echo',
  'env',
  'export',
  'cd',
  'ls',
  'cat',
  'mkdir',
  'rm',
  'cp',
  'mv',
  'grep',
  'rg',
  'find',
  'diff',
  'patch',
  'test',
]);

function parseCommand(
  tokens: string[],
  env: Record<string, string>,
  lastExitCode: number
): ParsedCommand {
  const args: string[] = [];
  const assignments: Record<string, string> = {};
  let redirectOut: ParsedCommand['redirectOut'];
  let redirectIn: string | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = expand(tokens[index], env, lastExitCode);
    if (token === '>' || token === '>>') {
      const path = tokens[++index];
      if (!path) throw new AgentError('SHELL_REDIRECT_INVALID', 'Missing redirect path');
      redirectOut = {
        path,
        append: token === '>>',
      };
      continue;
    }
    if (token === '<') {
      const path = tokens[++index];
      if (!path) throw new AgentError('SHELL_REDIRECT_INVALID', 'Missing input path');
      redirectIn = path;
      continue;
    }
    if (!args.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      const [key, ...value] = token.split('=');
      assignments[key] = value.join('=');
      continue;
    }
    args.push(token);
  }
  return { args, assignments, ...(redirectOut ? { redirectOut } : {}), ...(redirectIn ? { redirectIn } : {}) };
}

function tokenize(value: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (current) tokens.push(current);
    current = '';
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if ((char === '>' || char === '<') && current) push();
    if (char === '>') {
      const next = value[index + 1];
      tokens.push(next === '>' ? '>>' : '>');
      if (next === '>') index += 1;
      continue;
    }
    if (char === '<') {
      tokens.push('<');
      continue;
    }
    current += char;
  }
  if (quote) throw new AgentError('SHELL_QUOTE_UNTERMINATED', 'Unterminated quote');
  if (escaped) current += '\\';
  push();
  return tokens;
}

function splitOutsideQuotes(
  value: string,
  operators: string[]
): Array<{ value: string; operator?: string }> {
  const sorted = [...operators].sort((a, b) => b.length - a.length);
  const result: Array<{ value: string; operator?: string }> = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let pendingOperator: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    const operator = sorted.find((item) => value.startsWith(item, index));
    if (operator) {
      if (current || pendingOperator !== undefined) {
        result.push({ value: current.trim(), ...(pendingOperator ? { operator: pendingOperator } : {}) });
      }
      current = '';
      pendingOperator = operator;
      index += operator.length - 1;
      continue;
    }
    current += char;
  }
  if (quote) throw new AgentError('SHELL_QUOTE_UNTERMINATED', 'Unterminated quote');
  if (current || pendingOperator !== undefined) {
    result.push({ value: current.trim(), ...(pendingOperator ? { operator: pendingOperator } : {}) });
  }
  return result;
}

function expand(value: string, env: Record<string, string>, lastExitCode: number): string {
  return value.replace(/\$(\?|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g, (_match, token, braced, plain) => {
    if (token === '?') return String(lastExitCode);
    const key = braced ?? plain;
    return env[key] ?? '';
  });
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decode(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…(truncated)` : value;
}

function assertSupportedSyntax(value: string): void {
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (
      char === '`' ||
      (char === '$' && value[index + 1] === '(') ||
      ((char === '<' || char === '>') && value[index + 1] === '(')
    ) {
      throw new AgentError(
        'SHELL_SYNTAX_UNSUPPORTED',
        'Command substitution and process substitution are not supported'
      );
    }
  }
}
