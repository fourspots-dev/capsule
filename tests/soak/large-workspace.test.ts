import {
  mkdir,
  mkdtemp,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
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
      const startedAt = Date.now();
      try {
        await writeFile(join(root, 'source.bin'), '');
        await truncate(join(root, 'source.bin'), sizeMb * 1024 * 1024);
        await writeFile(join(root, 'README.md'), '# large fixture\n');
        for (let directory = 0; directory < 100; directory += 1) {
          const path = join(root, 'src', `d${directory}`);
          await mkdir(path, { recursive: true });
          await Promise.all(
            Array.from({ length: 100 }, (_, file) =>
              writeFile(
                join(path, `f${file}.ts`),
                directory === 99 && file === 99
                  ? 'export const needle = true;\n'
                  : `export const value = ${file};\n`
              )
            )
          );
        }
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
            pattern: 'needle',
            include: ['**/*.ts'],
          })
        ).toHaveLength(1);
        expect(
          (await vfs.list('src', { recursive: true })).filter(
            (entry) => entry.kind === 'file'
          )
        ).toHaveLength(10_000);
        const rssGrowth = process.memoryUsage().rss - initialRss;
        expect(rssGrowth).toBeLessThan(256 * 1024 * 1024);
        process.stdout.write(
          `Large workspace passed: ${sizeMb}MB + 10,000 files in ${Date.now() - startedAt}ms, RSS growth ${Math.round(rssGrowth / 1024 / 1024)}MB\n`
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    120_000
  );
});
