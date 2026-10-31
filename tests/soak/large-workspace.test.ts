import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeHostFileSystem } from '../../src/node/host-fs';
import { searchVirtualFiles } from '../../src/virtual';

const enabled = process.env.TINYAI_LARGE_WORKSPACE === '1';
const sizeMb = Math.max(
  64,
  Number(process.env.TINYAI_LARGE_WORKSPACE_MB ?? 1024)
);
const largeTest = enabled ? it : it.skip;

describe('large workspace acceptance', () => {
  largeTest(
    `fences and range-reads a ${sizeMb}MB workspace without loading it whole`,
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'tinyai-large-workspace-'));
      const initialRss = process.memoryUsage().rss;
      try {
        await writeFile(join(root, 'source.bin'), '');
        await truncate(join(root, 'source.bin'), sizeMb * 1024 * 1024);
        await writeFile(join(root, 'README.md'), '# large fixture\n');
        const vfs = new NodeHostFileSystem(root);
        const info = await vfs.stat('source.bin');
        expect(info?.size).toBe(sizeMb * 1024 * 1024);
        expect(
          (await vfs.read('source.bin', {
            offset: sizeMb * 1024 * 1024 - 32,
            length: 32,
          })).byteLength
        ).toBe(32);
        expect(
          await searchVirtualFiles(vfs, {
            pattern: 'large fixture',
            include: ['**/*.md'],
          })
        ).toHaveLength(1);
        const rssGrowth = process.memoryUsage().rss - initialRss;
        expect(rssGrowth).toBeLessThan(256 * 1024 * 1024);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000
  );
});
