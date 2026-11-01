import { describe, expect, it } from 'vitest';
import { discoverTests } from '../../src/evidence';
import { MemoryFileSystem } from '../../src/virtual';

describe('REQ-TEST-001 portable test discovery', () => {
  it('discovers JS, Python and Xcode test targets without executing them', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('src/value.test.ts', new Uint8Array());
    await vfs.write('src/value.spec.js', new Uint8Array());
    await vfs.write('server/test_api.py', new Uint8Array());
    await vfs.write('App/App.xcodeproj/project.pbxproj', new Uint8Array());
    expect(await discoverTests(vfs)).toEqual([
      { path: 'App/App.xcodeproj', framework: 'xcode', kind: 'project' },
      { path: 'server/test_api.py', framework: 'pytest', kind: 'file' },
      { path: 'src/value.spec.js', framework: 'jest', kind: 'file' },
      { path: 'src/value.test.ts', framework: 'vitest', kind: 'file' },
    ]);
  });
});
