import { describe, expect, it } from 'vitest';
import {
  globToRegExp,
  globVirtualFiles,
  hashVirtualBytes,
  MemoryFileSystem,
  searchVirtualFiles,
} from '../../src/virtual';

const encoder = new TextEncoder();

describe('virtual search', () => {
  it('searches text with include/exclude, case and context controls', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write(
      'src/auth.ts',
      encoder.encode('before\nconst Token = "abc";\nafter\n')
    );
    await vfs.write('src/auth.test.ts', encoder.encode('Token test\n'));
    await vfs.write('node_modules/pkg/index.ts', encoder.encode('Token ignored\n'));
    await vfs.write('assets/logo.bin', new Uint8Array([0, 255, 1]));

    expect(
      await searchVirtualFiles(vfs, {
        pattern: 'token',
        include: ['src/**/*.ts'],
        exclude: ['**/*.test.ts', 'node_modules/**'],
        contextLines: 1,
      })
    ).toEqual([
      {
        path: 'src/auth.ts',
        line: 2,
        column: 7,
        text: 'const Token = "abc";',
        before: ['before'],
        after: ['after'],
      },
    ]);
    expect(
      await searchVirtualFiles(vfs, {
        pattern: 'token',
        caseSensitive: true,
        include: ['src/auth.ts'],
      })
    ).toEqual([]);
  });

  it('supports regular expressions, whole words and result limits', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.ts', encoder.encode('cat category cat\ncat\n'));
    expect(
      await searchVirtualFiles(vfs, {
        pattern: 'cat',
        wholeWord: true,
        maxResults: 1,
      })
    ).toHaveLength(1);
    expect(
      await searchVirtualFiles(vfs, {
        pattern: 'cat\\s+category',
        regex: true,
      })
    ).toEqual([expect.objectContaining({ line: 1, column: 1 })]);
  });

  it('matches double-star and character-class globs deterministically', async () => {
    expect(globToRegExp('src/**/*.ts').test('src/a/b.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/a/b.js')).toBe(false);
    expect(globToRegExp('src/[ab]?.ts').test('src/a1.ts')).toBe(true);

    const vfs = new MemoryFileSystem();
    await vfs.write('src/a.ts', encoder.encode('a'));
    await vfs.write('src/nested/b.ts', encoder.encode('b'));
    await vfs.write('src/nested/c.js', encoder.encode('c'));
    expect(await globVirtualFiles(vfs, ['**/*.ts'])).toEqual([
      'src/a.ts',
      'src/nested/b.ts',
    ]);
  });

  it('returns stable content hashes', () => {
    expect(hashVirtualBytes(encoder.encode('abc'))).toBe(
      hashVirtualBytes(encoder.encode('abc'))
    );
    expect(hashVirtualBytes(encoder.encode('abc'))).not.toBe(
      hashVirtualBytes(encoder.encode('abd'))
    );
  });
});
