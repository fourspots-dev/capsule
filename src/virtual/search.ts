import { AgentError } from '../core/errors';
import { normalizeVirtualPath } from './path';
import type { VirtualFileSystem } from './types';

export interface VirtualSearchOptions {
  pattern: string;
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  contextLines?: number;
  maxResults?: number;
  signal?: AbortSignal;
}

export interface VirtualSearchMatch {
  path: string;
  line: number;
  column: number;
  text: string;
  before: string[];
  after: string[];
}

export interface VirtualGlobOptions {
  path?: string;
  exclude?: readonly string[];
  signal?: AbortSignal;
}

export async function searchVirtualFiles(
  vfs: VirtualFileSystem,
  options: VirtualSearchOptions
): Promise<VirtualSearchMatch[]> {
  if (!options.pattern) {
    throw new AgentError('SEARCH_PATTERN_EMPTY', 'Search pattern cannot be empty');
  }
  const matcher = compileMatcher(options);
  const include = (options.include ?? []).map(globToRegExp);
  const exclude = (options.exclude ?? []).map(globToRegExp);
  const maxResults = Math.max(1, options.maxResults ?? 200);
  const contextLines = Math.max(0, options.contextLines ?? 0);
  const files = await vfs.list(normalizeVirtualPath(options.path ?? ''), {
    recursive: true,
    signal: options.signal,
  });
  const matches: VirtualSearchMatch[] = [];
  for (const file of files) {
    if (options.signal?.aborted) {
      throw new AgentError('SEARCH_ABORTED', 'Virtual search was cancelled');
    }
    if (file.kind !== 'file') continue;
    if (include.length && !include.some((matcher) => matcher.test(file.path))) continue;
    if (exclude.some((matcher) => matcher.test(file.path))) continue;
    const text = decodeText(await vfs.read(file.path, { signal: options.signal }));
    if (text === undefined) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index].endsWith('\r') ? lines[index].slice(0, -1) : lines[index];
      const match = matcher.exec(line);
      matcher.lastIndex = 0;
      if (!match) continue;
      matches.push({
        path: file.path,
        line: index + 1,
        column: match.index + 1,
        text: line,
        before: lines.slice(Math.max(0, index - contextLines), index),
        after: lines.slice(index + 1, index + 1 + contextLines),
      });
      if (matches.length >= maxResults) return matches;
    }
  }
  return matches;
}

export async function globVirtualFiles(
  vfs: VirtualFileSystem,
  patterns: readonly string[],
  options: VirtualGlobOptions = {}
): Promise<string[]> {
  if (!patterns.length) {
    throw new AgentError('GLOB_PATTERN_EMPTY', 'At least one glob pattern is required');
  }
  const includes = patterns.map(globToRegExp);
  const excludes = (options.exclude ?? []).map(globToRegExp);
  const entries = await vfs.list(normalizeVirtualPath(options.path ?? ''), {
    recursive: true,
    signal: options.signal,
  });
  return entries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.path)
    .filter((path) => includes.some((pattern) => pattern.test(path)))
    .filter((path) => !excludes.some((pattern) => pattern.test(path)))
    .sort();
}

export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replaceAll('\\', '/').replace(/^\/+/, '');
  let source = '';
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }
    if (char === '?') {
      source += '[^/]';
      continue;
    }
    if (char === '[') {
      const end = normalized.indexOf(']', index + 1);
      if (end > index) {
        const body = normalized.slice(index + 1, end);
        source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
        index = end;
        continue;
      }
    }
    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`, 'u');
}

export function hashVirtualBytes(data: Uint8Array): string {
  let hash = 1469598103934665603n;
  for (const byte of data) {
    hash ^= BigInt(byte);
    hash = (hash * 1099511628211n) & 0xffffffffffffffffn;
  }
  return `${data.byteLength.toString(16)}-${hash.toString(16).padStart(16, '0')}`;
}

export function decodeVirtualText(value: Uint8Array): string | undefined {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return undefined;
  }
}

function compileMatcher(options: VirtualSearchOptions): RegExp {
  const flags = options.caseSensitive ? 'u' : 'iu';
  if (options.regex) {
    try {
      return new RegExp(options.pattern, flags);
    } catch (error) {
      throw new AgentError(
        'SEARCH_REGEX_INVALID',
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  const escaped = escapeRegExp(options.pattern);
  return new RegExp(options.wholeWord ? `\\b${escaped}\\b` : escaped, flags);
}

function decodeText(value: Uint8Array): string | undefined {
  const text = decodeVirtualText(value);
  return text?.includes('\0') ? undefined : text;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
