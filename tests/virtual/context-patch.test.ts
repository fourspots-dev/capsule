import { describe, expect, it } from 'vitest';
import {
  applyContextPatch,
  hashVirtualBytes,
  MemoryFileSystem,
  parseContextPatch,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('virtual context patch', () => {
  it('applies update, add, delete and move without hunk counts', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('one\ntwo\n'));
    await vfs.write('remove.txt', encoder.encode('remove\n'));
    await vfs.write('old.txt', encoder.encode('moved\n'));

    const result = await applyContextPatch(
      vfs,
      [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@',
        ' one',
        '-two',
        '+three',
        '+four',
        '*** Add File: new.txt',
        '+new',
        '',
        '*** Delete File: remove.txt',
        '*** Update File: old.txt',
        '*** Move to: renamed.txt',
        '*** End Patch',
      ].join('\n')
    );

    expect(decoder.decode(await vfs.read('a.txt'))).toBe('one\nthree\nfour\n');
    expect(decoder.decode(await vfs.read('new.txt'))).toBe('new\n');
    expect(await vfs.stat('remove.txt')).toBeUndefined();
    expect(await vfs.stat('old.txt')).toBeUndefined();
    expect(decoder.decode(await vfs.read('renamed.txt'))).toBe('moved\n');
    expect(result.files.map((file) => file.status).sort()).toEqual([
      'added',
      'deleted',
      'modified',
      'moved',
    ]);
    expect(result.unifiedDiff).toContain('--- a/a.txt');
    expect(result.unifiedDiff).toContain('+++ b/new.txt');
  });

  it('supports blank context and End of File', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write(
      'a.txt',
      encoder.encode('function value() {\n\n  return 1;\n}\n')
    );
    await applyContextPatch(
      vfs,
      [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@ function value()',
        ' ',
        '-  return 1;',
        '+  return 2;',
        '*** End Patch',
      ].join('\n')
    );
    expect(decoder.decode(await vfs.read('a.txt'))).toBe(
      'function value() {\n\n  return 2;\n}\n'
    );
    await applyContextPatch(
      vfs,
      [
        '*** Begin Patch',
        '*** Update File: a.txt',
        '@@',
        ' }',
        '+// end',
        '*** End of File',
        '*** End Patch',
      ].join('\n')
    );
    expect(decoder.decode(await vfs.read('a.txt'))).toBe(
      'function value() {\n\n  return 2;\n}\n// end\n'
    );
  });

  it('matches CRLF files and preserves their line-ending style', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('crlf.txt', encoder.encode('one\r\ntwo\r\n'));
    await applyContextPatch(
      vfs,
      [
        '*** Begin Patch',
        '*** Update File: crlf.txt',
        '@@',
        ' one',
        '-two',
        '+three',
        '*** End Patch',
      ].join('\r\n')
    );
    expect(decoder.decode(await vfs.read('crlf.txt'))).toBe(
      'one\r\nthree\r\n'
    );
  });

  it('returns structured not-found and ambiguous context errors', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('same\nsame\n'));
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-same',
          '+other',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({
      code: 'PATCH_CONTEXT_AMBIGUOUS',
      details: { path: 'a.txt', candidates: [1, 2] },
    });
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-missing',
          '+other',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({
      code: 'PATCH_CONTEXT_NOT_FOUND',
      details: { path: 'a.txt' },
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('same\nsame\n');
  });

  it('requires a supplied anchor to exist and rejects unified line counts', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('unique\n'));
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@ missing anchor',
          '-unique',
          '+changed',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({
      code: 'PATCH_CONTEXT_NOT_FOUND',
      details: { anchor: 'missing anchor' },
    });
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@ -1 +1 @@',
          '-unique',
          '+changed',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({
      code: 'PATCH_PROTOCOL_INVALID',
      details: { suggestion: expect.stringContaining('apply_unified_diff') },
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('unique\n');
  });

  it('checks expected versions and hashes without mutation', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('current\n'));
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.txt',
      '@@',
      '-current',
      '+changed',
      '*** End Patch',
    ].join('\n');
    await expect(
      applyContextPatch(vfs, patch, { expectedVersions: { 'a.txt': 99 } })
    ).rejects.toMatchObject({
      code: 'PATCH_STALE_FILE',
      details: { expectedVersion: 99 },
    });
    await expect(
      applyContextPatch(vfs, patch, { expectedHashes: { 'a.txt': 'stale' } })
    ).rejects.toMatchObject({ code: 'PATCH_STALE_FILE' });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('current\n');
    await applyContextPatch(vfs, patch, {
      expectedVersions: { 'a.txt': 1 },
      expectedHashes: {
        'a.txt': hashVirtualBytes(encoder.encode('current\n')),
      },
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('changed\n');
  });

  it('rolls back every file when a later write fails', async () => {
    class FailingFileSystem extends MemoryFileSystem {
      fail = false;
      override async write(
        path: string,
        data: Uint8Array,
        options: Parameters<MemoryFileSystem['write']>[2] = {}
      ) {
        if (this.fail && path === 'b.txt') throw new Error('simulated write failure');
        return super.write(path, data, options);
      }
    }
    const vfs = new FailingFileSystem();
    await vfs.write('a.txt', encoder.encode('a\n'));
    await vfs.write('b.txt', encoder.encode('b\n'));
    vfs.fail = true;
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-a',
          '+aa',
          '*** Update File: b.txt',
          '@@',
          '-b',
          '+bb',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toThrow('simulated write failure');
    vfs.fail = false;
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('a\n');
    expect(decoder.decode(await vfs.read('b.txt'))).toBe('b\n');
  });

  it('rejects raw unified diffs and malformed boundaries', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('one\n'));
    await expect(
      applyContextPatch(
        vfs,
        ['--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+two', ''].join(
          '\n'
        )
      )
    ).rejects.toMatchObject({
      code: 'PATCH_PROTOCOL_INVALID',
      details: { suggestion: expect.stringContaining('apply_unified_diff') },
    });
    expect(() => parseContextPatch('*** Update File: a.txt')).toThrow(
      /Begin Patch/
    );
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('one\n');
  });

  it('rejects duplicate operations and binary edits', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('a\n'));
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: a.txt',
          '@@',
          '-a',
          '+b',
          '*** Delete File: a.txt',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({ code: 'PATCH_PROTOCOL_INVALID' });
    await vfs.write('image.bin', new Uint8Array([0, 255]));
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: image.bin',
          '@@',
          '-x',
          '+y',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({ code: 'PATCH_BINARY_UNSUPPORTED' });
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: /absolute.txt',
          '@@',
          '-missing',
          '+other',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({ code: 'PATCH_PATH_INVALID' });
  });

  it('rejects a Move target that already exists', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('old.txt', encoder.encode('old\n'));
    await vfs.write('target.txt', encoder.encode('target\n'));
    await expect(
      applyContextPatch(
        vfs,
        [
          '*** Begin Patch',
          '*** Update File: old.txt',
          '*** Move to: target.txt',
          '*** End Patch',
        ].join('\n')
      )
    ).rejects.toMatchObject({ code: 'PATCH_TARGET_EXISTS' });
    expect(decoder.decode(await vfs.read('old.txt'))).toBe('old\n');
    expect(decoder.decode(await vfs.read('target.txt'))).toBe('target\n');
  });
});
