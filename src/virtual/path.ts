import { AgentError } from '../core/errors';

export function normalizeVirtualPath(path: string): string {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new AgentError(
        'VFS_PATH_INVALID',
        `Path escapes virtual workspace: ${path}`
      );
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function parentVirtualPath(path: string): string {
  const normalized = normalizeVirtualPath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function pathSegments(path: string): string[] {
  const normalized = normalizeVirtualPath(path);
  return normalized ? normalized.split('/') : [];
}

export function isPathInside(path: string, parent: string): boolean {
  const normalizedPath = normalizeVirtualPath(path);
  const normalizedParent = normalizeVirtualPath(parent);
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

export function joinVirtualPath(...parts: string[]): string {
  return normalizeVirtualPath(parts.filter(Boolean).join('/'));
}
