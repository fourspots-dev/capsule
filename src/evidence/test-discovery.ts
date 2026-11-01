import type { VirtualFileSystem } from '../virtual';

/** Portable test discovery is filesystem-facing, not Core state. */
export type TestFramework = 'vitest' | 'jest' | 'pytest' | 'xcode' | 'unknown';

export interface TestCandidate {
  path: string;
  framework: TestFramework;
  kind: 'file' | 'project';
}

export async function discoverTests(
  vfs: VirtualFileSystem
): Promise<TestCandidate[]> {
  const files = await vfs.list('', { recursive: true });
  const candidates: TestCandidate[] = [];
  for (const file of files) {
    if (file.kind !== 'file') continue;
    if (
      /(^|\/)(?:[^/]+\.)?(?:test|spec)\.[cm]?[jt]sx?$/.test(file.path)
    ) {
      candidates.push({
        path: file.path,
        framework: /\.spec\./.test(file.path) ? 'jest' : 'vitest',
        kind: 'file',
      });
    } else if (
      /(^|\/)test_[^/]+\.py$/.test(file.path) ||
      /(^|\/)[^/]+_test\.py$/.test(file.path)
    ) {
      candidates.push({
        path: file.path,
        framework: 'pytest',
        kind: 'file',
      });
    } else if (file.path.endsWith('.xcodeproj/project.pbxproj')) {
      candidates.push({
        path: file.path.replace(/\/project\.pbxproj$/, ''),
        framework: 'xcode',
        kind: 'project',
      });
    }
  }
  return candidates.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}
