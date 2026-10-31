import { AgentError } from '../core/errors';

const windowsReserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export function validatePortableWorkspacePaths(
  paths: readonly string[]
): void {
  const folded = new Map<string, string>();
  for (const original of paths) {
    const path = original.normalize('NFC');
    if (!path || path.startsWith('/') || path.startsWith('\\')) {
      throw invalid(path, 'Paths must be non-empty and relative');
    }
    if (path.includes('\0')) throw invalid(original, 'Paths cannot contain NUL');
    if (/^[A-Za-z]:/.test(path) || path.startsWith('//')) {
      throw invalid(original, 'Drive and UNC paths are not portable');
    }
    for (const segment of path.split('/')) {
      if (!segment || segment === '.' || segment === '..') {
        throw invalid(original, 'Dot path segments are not portable');
      }
      if (/[<>:"|?*]/.test(segment) || /[\x00-\x1f]/.test(segment)) {
        throw invalid(original, 'Filename contains a non-portable character');
      }
      if (
        windowsReserved.test(segment) ||
        segment.endsWith('.') ||
        segment.endsWith(' ')
      ) {
        throw invalid(original, 'Filename is reserved or ambiguous on Windows');
      }
    }
    const key = path.toLocaleLowerCase('en-US');
    const existing = folded.get(key);
    if (existing && existing !== path) {
      throw invalid(
        original,
        `Path collides by case with ${existing}`
      );
    }
    folded.set(key, path);
  }
}

function invalid(path: string, detail: string): AgentError {
  return new AgentError(
    'WORKSPACE_PATH_NOT_PORTABLE',
    `Workspace path is not portable (${detail}): ${path}`
  );
}
