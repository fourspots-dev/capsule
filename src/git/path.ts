import { AgentError } from '../core/errors';

export function normalizeGitPath(path: string): string {
  if (path.includes('\0')) {
    throw new AgentError('GIT_PATH_INVALID', 'Git path contains NUL');
  }
  const normalized = path
    .replaceAll('\\', '/')
    .normalize('NFC')
    .replace(/^\/+/, '');
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')) {
    throw new AgentError('GIT_PATH_INVALID', `Absolute Git path is not allowed: ${path}`);
  }
  const parts: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      throw new AgentError(
        'GIT_PATH_INVALID',
        `Git path escapes workspace: ${path}`
      );
    }
    if (part === '.git') {
      throw new AgentError('GIT_PATH_RESERVED', 'The .git directory is reserved');
    }
    parts.push(part);
  }
  return parts.join('/');
}

export function parentGitPath(path: string): string {
  const normalized = normalizeGitPath(path);
  const index = normalized.lastIndexOf('/');
  return index < 0 ? '' : normalized.slice(0, index);
}

export function joinGitPath(...parts: readonly string[]): string {
  return normalizeGitPath(parts.filter(Boolean).join('/'));
}

export function isGitPathInside(path: string, parent: string): boolean {
  const normalizedPath = normalizeGitPath(path);
  const normalizedParent = normalizeGitPath(parent);
  return (
    normalizedPath === normalizedParent ||
    normalizedPath.startsWith(`${normalizedParent}/`)
  );
}

export function assertBranchName(name: string): void {
  if (
    !name ||
    name.startsWith('-') ||
    name.startsWith('/') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    name.includes('..') ||
    name.includes('@{') ||
    /[\s~^:?*[\]\\\0]/.test(name)
  ) {
    throw new AgentError('GIT_BRANCH_INVALID', `Invalid Git branch name: ${name}`);
  }
}
