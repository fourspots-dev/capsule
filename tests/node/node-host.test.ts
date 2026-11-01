import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inspectHostCapabilities } from '../../src/host';
import { NodeHostBridge, NodeHostStorage } from '../../src/node/node-host';
import { NodeHostFileSystem } from '../../src/node/host-fs';
import { parseWorkspaceBundle } from '../../src/virtual';

describe('NodeHostBridge', () => {
  it('imports a project as an opaque bundle while skipping generated directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-node-host-'));
    try {
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(root, 'src', 'index.ts'), 'export const ok = true;\n');
      await writeFile(join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');
      const host = new NodeHostBridge({ projectRoot: root, stateRoot: join(root, '.tinyai') });
      expect(inspectHostCapabilities(host).healthy).toBe(true);
      const bundle = parseWorkspaceBundle((await host.workspace.importWorkspace!())!);
      expect(bundle.files.map((file) => file.path)).toEqual(['src/index.ts']);
      expect(
        Buffer.from(bundle.files[0].dataBase64, 'base64').toString('utf8')
      ).toBe('export const ok = true;\n');
      expect(bundle.directories).toContain('src');
      expect(bundle.directories).not.toContain('node_modules');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists host storage atomically across bridge instances', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-node-storage-'));
    const path = join(root, 'state.json');
    try {
      const first = new NodeHostStorage(path);
      await first.set('a', { value: 1 });
      await first.set('b', ['two']);
      await first.remove('a');
      const second = new NodeHostStorage(path);
      expect(await second.get('a')).toBeUndefined();
      expect(await second.get('b')).toEqual(['two']);
      expect(await second.list()).toEqual(['b']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exposes an explicitly configured host filesystem baseline port', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-node-fs-baseline-'));
    try {
      const host = new NodeHostBridge({
        projectRoot: root,
        stateRoot: join(root, '.tinyai'),
        filesystem: new NodeHostFileSystem(root),
      });
      expect(inspectHostCapabilities(host)).toMatchObject({
        healthy: true,
      });
      expect(host.filesystem).toBeInstanceOf(NodeHostFileSystem);
      expect(inspectHostCapabilities(host).available).toContain('filesystem');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
