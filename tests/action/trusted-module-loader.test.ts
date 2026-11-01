import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TrustedActionModuleLoader } from '../../src/node/actions/trusted-module-loader';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

describe('REQ-ACTION-001 trusted Action module loader', () => {
  it('loads an explicitly allowlisted versioned provider module with hash verification', async () => {
    const root = await workspace();
    const modulePath = join(root, 'provider.mjs');
    const source = providerModule('review-module');
    await writeFile(modulePath, source);
    const sha256 = createHash('sha256').update(source).digest('hex');
    const loader = new TrustedActionModuleLoader({
      workspaceRoot: root,
      allowedModules: [
        { path: modulePath, sha256, expectedId: 'review-module' },
      ],
    });
    const loaded = await loader.load(modulePath);
    expect(loaded).toMatchObject({
      id: 'review-module',
      path: await realpath(modulePath),
      sha256,
    });
    expect(await loaded.provider.describe()).toMatchObject([
      { id: 'app.example.check' },
    ]);
  });

  it('rejects relative, unregistered and hash-mismatched modules', async () => {
    const root = await workspace();
    const modulePath = join(root, 'provider.mjs');
    await writeFile(modulePath, providerModule('review-module'));
    expect(
      () =>
        new TrustedActionModuleLoader({
          allowedModules: [{ path: './provider.mjs' }],
        })
    ).toThrow(/absolute/);

    const loader = new TrustedActionModuleLoader({
      allowedModules: [
        {
          path: modulePath,
          sha256: '0'.repeat(64),
        },
      ],
    });
    await expect(loader.load(modulePath)).rejects.toMatchObject({
      code: 'ACTION_MODULE_HASH_MISMATCH',
    });
    await expect(loader.load(join(root, 'other.mjs'))).rejects.toMatchObject({
      code: 'ACTION_MODULE_NOT_ALLOWED',
    });
  });

  it('does not auto-load workspace code and rejects invalid module contracts', async () => {
    const root = await workspace();
    const modulePath = join(root, 'provider.mjs');
    await writeFile(
      modulePath,
      'export default { apiVersion: 2, id: "invalid", create() {} };\n'
    );
    const loader = new TrustedActionModuleLoader({
      allowedModules: [{ path: modulePath }],
    });
    await expect(loader.load(modulePath)).rejects.toMatchObject({
      code: 'ACTION_MODULE_INVALID',
    });
    const empty = new TrustedActionModuleLoader({ allowedModules: [] });
    await expect(empty.load(modulePath)).rejects.toMatchObject({
      code: 'ACTION_MODULE_NOT_ALLOWED',
    });
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tinyai-action-module-'));
  roots.push(root);
  return root;
}

function providerModule(id: string): string {
  return `
export const actionModule = {
  apiVersion: 1,
  id: ${JSON.stringify(id)},
  async create(_context) {
    return {
      async describe() {
        return [{
          id: 'app.example.check',
          version: '1.0.0',
          title: 'Example',
          description: 'Example check',
          inputSchema: { type: 'object', properties: {} },
          effects: ['execute'],
          risk: 'dangerous',
          probe: async () => ({ state: 'available' })
        }];
      },
      async invoke() {
        return { value: { ok: true } };
      }
    };
  }
};
`;
}
