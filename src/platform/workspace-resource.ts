import { AgentError } from '../core/errors';

export type WorkspacePath = string & {
  readonly __workspacePath: unique symbol;
};

export interface WorkspaceScope {
  workspaceId: string;
  kind: 'group' | 'tab' | 'session' | 'global';
  displayName: string;
  generation: number;
}

export interface WorkspaceResourceRef {
  workspaceId: string;
  path: WorkspacePath;
  generation: number;
}

export interface WorkspaceResourceDescriptor extends WorkspaceResourceRef {
  resourceUri: string;
  mimeType: string;
  size: number;
  version: number;
  openable: boolean;
  exportable: boolean;
}

export interface WorkspaceResourceReadPort {
  describe(workspaceId: string, path: WorkspacePath): Promise<WorkspaceResourceDescriptor>;
  read(workspaceId: string, path: WorkspacePath): Promise<Uint8Array>;
}

export interface WorkspaceScopeResolverPort<TContext> {
  resolve(context: TContext): Promise<WorkspaceScope>;
}

export function workspacePath(
  value: string,
  options: { allowRoot?: boolean } = {}
): WorkspacePath {
  if (typeof value !== 'string') {
    throw pathError('WORKSPACE_PATH_INVALID', 'Workspace path must be a string');
  }
  const root = value === '' || value === '.';
  if (root) {
    if (options.allowRoot) return '' as WorkspacePath;
    throw pathError('WORKSPACE_PATH_INVALID', 'Workspace root is not a file path');
  }
  if (value.length > 4096) {
    throw pathError('WORKSPACE_PATH_TOO_LONG', 'Workspace path exceeds 4096 characters');
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    value.includes('\0') ||
    /[\u0001-\u001f\u007f]/.test(value)
  ) {
    throw pathError(
      'WORKSPACE_PATH_INVALID',
      'Workspace paths must be relative POSIX paths without control characters'
    );
  }
  if (
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) ||
    /^[a-zA-Z]:/.test(value) ||
    value.startsWith('~')
  ) {
    throw pathError(
      'WORKSPACE_PATH_NOT_HOST_PATH',
      'Workspace paths must not contain a URI scheme, host drive or home shortcut'
    );
  }
  if (value.includes('//')) {
    throw pathError('WORKSPACE_PATH_INVALID', 'Workspace path contains an empty segment');
  }
  const decoded = safeDecode(value);
  if (
    /(?:^|\/)\.\.(?:\/|$)/.test(decoded) ||
    /%2e%2e|%2f|%5c/i.test(value)
  ) {
    throw pathError(
      'WORKSPACE_PATH_ESCAPE',
      'Workspace path must not escape its workspace root'
    );
  }
  const normalized = value
    .normalize('NFC')
    .replace(/\/+$/, '');
  const segments = normalized.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') {
      throw pathError('WORKSPACE_PATH_INVALID', 'Workspace path contains an invalid segment');
    }
    if (segment.length > 255) {
      throw pathError('WORKSPACE_PATH_TOO_LONG', 'Workspace path segment exceeds 255 characters');
    }
    if (/[<>:"|?*]/.test(segment) || /[. ]$/.test(segment)) {
      throw pathError(
        'WORKSPACE_PATH_INVALID',
        'Workspace path contains a non-portable filename segment'
      );
    }
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment)) {
      throw pathError(
        'WORKSPACE_PATH_INVALID',
        'Workspace path contains a reserved host filename'
      );
    }
  }
  return normalized as WorkspacePath;
}

export function workspaceResourceRef(input: {
  workspaceId: string;
  path: string;
  generation: number;
  allowRoot?: boolean;
}): WorkspaceResourceRef {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(input.workspaceId)) {
    throw pathError('WORKSPACE_SCOPE_INVALID', 'Workspace id is invalid');
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    throw pathError('WORKSPACE_RESOURCE_STALE', 'Workspace generation is invalid');
  }
  return {
    workspaceId: input.workspaceId,
    path: workspacePath(input.path, {
      allowRoot: input.allowRoot === true,
    }),
    generation: input.generation,
  };
}

export function workspaceResourceUri(
  workspaceId: string,
  path: WorkspacePath
): string {
  const encodedPath = path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `workspace://${encodeURIComponent(workspaceId)}/${encodedPath}`;
}

export function workspaceMimeType(path: string): string {
  const extension = path.toLowerCase().split('.').pop() ?? '';
  const values: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    htm: 'text/html; charset=utf-8',
    css: 'text/css; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json',
    svg: 'image/svg+xml',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    pdf: 'application/pdf',
    txt: 'text/plain; charset=utf-8',
    md: 'text/markdown; charset=utf-8',
  };
  return values[extension] ?? 'application/octet-stream';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw pathError('WORKSPACE_PATH_INVALID', 'Workspace path has invalid percent encoding');
  }
}

function pathError(code: string, message: string): AgentError {
  return new AgentError(code, message);
}
