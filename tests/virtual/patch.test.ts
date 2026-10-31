import { describe, expect, it } from 'vitest';
import { AgentError } from '../../src/core';
import {
  applyUnifiedPatch,
  hashVirtualBytes,
  MemoryFileSystem,
  VirtualShell,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('virtual unified patch', () => {
  it('applies modifications, additions and deletions', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('one\ntwo\n'));
    await vfs.write('remove.txt', encoder.encode('remove\n'));
    const result = await applyUnifiedPatch(
      vfs,
      [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,2 +1,3 @@',
        ' one',
        '-two',
        '+three',
        '+four',
        '--- /dev/null',
        '+++ b/new.txt',
        '@@ -0,0 +1,1 @@',
        '+new',
        '--- a/remove.txt',
        '+++ /dev/null',
        '@@ -1,1 +0,0 @@',
        '-remove',
        '',
      ].join('\n')
    );
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('one\nthree\nfour\n');
    expect(decoder.decode(await vfs.read('new.txt'))).toBe('new\n');
    expect(await vfs.stat('remove.txt')).toBeUndefined();
    expect(result).toMatchObject({ additions: 3, deletions: 2 });
  });

  it('rejects stale versions, stale hashes and mismatched context without mutation', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('current\n'));
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,1 +1,1 @@',
      '-original',
      '+changed',
      '',
    ].join('\n');
    await expect(applyUnifiedPatch(vfs, patch)).rejects.toMatchObject({
      code: 'PATCH_CONTEXT_MISMATCH',
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('current\n');

    const valid = patch.replace('-original', '-current');
    await expect(
      applyUnifiedPatch(vfs, valid, { expectedVersions: { 'a.txt': 99 } })
    ).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await expect(
      applyUnifiedPatch(vfs, valid, { expectedHashes: { 'a.txt': 'stale' } })
    ).rejects.toMatchObject({ code: 'PATCH_CONFLICT' });
    await applyUnifiedPatch(vfs, valid, {
      expectedVersions: { 'a.txt': 1 },
      expectedHashes: { 'a.txt': hashVirtualBytes(encoder.encode('current\n')) },
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('changed\n');
  });

  it('rolls back earlier file writes when a later write fails', async () => {
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
      applyUnifiedPatch(
        vfs,
        [
          '--- a/a.txt',
          '+++ b/a.txt',
          '@@ -1,1 +1,1 @@',
          '-a',
          '+aa',
          '--- a/b.txt',
          '+++ b/b.txt',
          '@@ -1,1 +1,1 @@',
          '-b',
          '+bb',
          '',
        ].join('\n')
      )
    ).rejects.toThrow('simulated write failure');
    vfs.fail = false;
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('a\n');
    expect(decoder.decode(await vfs.read('b.txt'))).toBe('b\n');
  });

  it('rejects malformed and binary patches', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('image.bin', new Uint8Array([0, 255]));
    await expect(applyUnifiedPatch(vfs, 'not a patch')).rejects.toBeInstanceOf(
      AgentError
    );
    await expect(
      applyUnifiedPatch(
        vfs,
        [
          '--- a/image.bin',
          '+++ b/image.bin',
          '@@ -1,1 +1,1 @@',
          '-x',
          '+y',
          '',
        ].join('\n')
      )
    ).rejects.toMatchObject({ code: 'PATCH_BINARY_UNSUPPORTED' });
  });

  it('exposes patch as a Virtual Shell builtin using stdin', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('a.txt', encoder.encode('old\n'));
    const shell = new VirtualShell(vfs);
    const result = await shell.execute('patch', {
      stdin: [
        '--- a/a.txt',
        '+++ b/a.txt',
        '@@ -1,1 +1,1 @@',
        '-old',
        '+new',
        '',
      ].join('\n'),
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: 'patched 1 file(s) (+1/-1)\n',
    });
    expect(decoder.decode(await vfs.read('a.txt'))).toBe('new\n');
  });
});
