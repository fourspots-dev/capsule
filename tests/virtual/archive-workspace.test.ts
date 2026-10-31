import { describe, expect, it } from 'vitest';
import { MemoryHostBridge, type HostBridge } from '../../src/host';
import {
  ArchiveFileSystem,
  createVirtualWorkspace,
  createWorkspaceBundle,
  exportWorkspaceBundle,
  importWorkspaceBundle,
  MemoryFileSystem,
  MemoryKeyValueStore,
  parseWorkspaceBundle,
  serializeWorkspaceBundle,
  VirtualWorkspace,
  WORKSPACE_BUNDLE_FORMAT,
  WORKSPACE_BUNDLE_SCHEMA_VERSION,
} from '../../src/virtual';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('ArchiveFileSystem and workspace bundles', () => {
  it('round-trips directories, binary files and metadata through a bundle', async () => {
    const vfs = new MemoryFileSystem(() => 10);
    await vfs.mkdir('src', { recursive: true });
    await vfs.write('src/index.ts', encoder.encode('export const value = 1;\n'));
    await vfs.write('assets/logo.bin', new Uint8Array([0, 255, 1]));

    const bundle = await exportWorkspaceBundle(vfs, {
      now: () => 20,
      revision: 'snapshot_1',
      metadata: { project: 'tinyai' },
    });
    const parsed = parseWorkspaceBundle(serializeWorkspaceBundle(bundle));
    expect(parsed).toMatchObject({
      format: WORKSPACE_BUNDLE_FORMAT,
      schemaVersion: WORKSPACE_BUNDLE_SCHEMA_VERSION,
      revision: 'snapshot_1',
      metadata: { project: 'tinyai' },
    });

    const archive = new ArchiveFileSystem(parsed);
    expect(decoder.decode(await archive.read('src/index.ts'))).toBe(
      'export const value = 1;\n'
    );
    expect(await archive.read('assets/logo.bin')).toEqual(
      new Uint8Array([0, 255, 1])
    );
    await expect(archive.write('new.txt', encoder.encode('no'))).rejects.toMatchObject({
      code: 'VFS_READ_ONLY',
    });
  });

  it('validates traversal, duplicate paths and invalid base64 before mutation', async () => {
    expect(() =>
      createWorkspaceBundle({
        files: [{ path: '../escape', dataBase64: '' }],
      })
    ).toThrow(/Path escapes virtual workspace/);
    expect(() =>
      createWorkspaceBundle({
        directories: ['src'],
        files: [{ path: 'src', dataBase64: '' }],
      })
    ).toThrow(/Duplicate bundle path/);
    expect(() =>
      createWorkspaceBundle({
        files: [{ path: 'bad.txt', dataBase64: '***' }],
      })
    ).toThrow(/Invalid base64 data/);
    expect(() =>
      createWorkspaceBundle({
        files: [
          { path: 'src', dataBase64: '' },
          { path: 'src/nested.ts', dataBase64: btoa('nested') },
        ],
      })
    ).toThrow(/cannot contain another path/);
  });

  it('imports into a mutable VFS and replaces an existing tree only when requested', async () => {
    const vfs = new MemoryFileSystem();
    await vfs.write('old.txt', encoder.encode('old'));
    const bundle = createWorkspaceBundle({
      files: [{ path: 'src/new.ts', dataBase64: btoa('new') }],
    });

    await importWorkspaceBundle(vfs, bundle);
    expect(decoder.decode(await vfs.read('old.txt'))).toBe('old');
    expect(decoder.decode(await vfs.read('src/new.ts'))).toBe('new');

    await importWorkspaceBundle(vfs, bundle, { replace: true });
    expect(await vfs.stat('old.txt')).toBeUndefined();
    expect(decoder.decode(await vfs.read('src/new.ts'))).toBe('new');
  });
});

describe('VirtualWorkspace and HostBridge integration', () => {
  it('persists through host storage and can reopen without an OS filesystem', async () => {
    const storage = new MemoryKeyValueStore();
    const host = new MemoryHostBridge({
      storage: {
        get: (key) => storage.get(key),
        set: (key, value) => storage.set(key, value),
        remove: (key) => storage.remove(key),
      },
    });
    const first = new VirtualWorkspace({ host, storageKey: 'workspace:test' });
    await first.fs.write('hello.txt', encoder.encode('persisted'));
    await first.checkpoint('saved');

    const second = new VirtualWorkspace({ host, storageKey: 'workspace:test' });
    expect(decoder.decode(await second.fs.read('hello.txt'))).toBe('persisted');
    expect(await second.status()).toMatchObject({
      fileCount: 1,
      persistent: true,
    });
  });

  it('imports and exports through optional host workspace bridges', async () => {
    let exported: Uint8Array | undefined;
    const base = new MemoryHostBridge();
    const host: HostBridge = {
      ...base,
      descriptor: {
        ...base.descriptor,
        capabilities: [
          ...base.descriptor.capabilities,
          'workspace.import',
          'workspace.export',
        ],
      },
      workspace: {
        async importWorkspace() {
          return exported;
        },
        async exportWorkspace(data) {
          exported = new Uint8Array(data);
        },
      },
    };
    const source = await createVirtualWorkspace({ host });
    await source.fs.write('project.ts', encoder.encode('const ok = true;\n'));
    await source.syncToHost();

    const imported = await createVirtualWorkspace({
      host,
      storageKey: 'workspace:imported',
      importFromHost: true,
    });
    expect(decoder.decode(await imported.fs.read('project.ts'))).toBe(
      'const ok = true;\n'
    );
  });

  it('uses memory even when storage exists but is not declared', async () => {
    const base = new MemoryHostBridge({
      descriptor: { id: 'memory-only', capabilities: ['clock'] },
    });
    const workspace = new VirtualWorkspace({ host: base });
    await workspace.fs.write('temporary.txt', encoder.encode('temporary'));

    expect(await workspace.status()).toMatchObject({
      persistent: false,
      fileCount: 1,
    });
  });

  it('runs and persists background shell jobs through the workspace', async () => {
    const host = new MemoryHostBridge();
    const workspace = new VirtualWorkspace({ host, storageKey: 'workspace:jobs' });
    const job = await workspace.jobs.start('echo job-output');
    await expect(workspace.jobs.wait(job.id)).resolves.toMatchObject({
      status: 'completed',
      stdout: 'job-output\n',
    });
    expect(
      (await new VirtualWorkspace({ host, storageKey: 'workspace:jobs' }).jobs.list())[0]
    ).toMatchObject({
      id: job.id,
      status: 'completed',
    });
  });
});
