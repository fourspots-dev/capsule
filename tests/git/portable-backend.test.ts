import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { PortableGitBackend } from '../../src/git/backend';
import { NodeHostFileSystem } from '../../src/node/host-fs';
import { MemoryFileSystem } from '../../src/virtual';

const exec = promisify(execFile);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('PortableGitBackend', () => {
  it('initializes, stages, commits, branches, checks out and migrates a repository', async () => {
    const fs = new MemoryFileSystem(() => 1_700_000_000_000);
    const git = new PortableGitBackend(fs, {
      now: () => 1_700_000_000_000,
      defaultAuthor: {
        name: 'TinyAI',
        email: 'tinyai@example.test',
        timezone: '+0800',
      },
    });
    await git.init({ initialBranch: 'main' });
    await fs.write('src/index.ts', encoder.encode('export const value = 1;\n'));
    await fs.write('README.md', encoder.encode('# Game\n'));

    expect(await git.status()).toMatchObject({
      branch: 'main',
      untracked: ['README.md', 'src/index.ts'],
      clean: false,
    });
    await git.add(['.']);
    expect(await git.status()).toMatchObject({
      staged: [
        { path: 'README.md', index: 'added', staged: true },
        { path: 'src/index.ts', index: 'added', staged: true },
      ],
      untracked: [],
    });
    const first = await git.commit({ message: 'initial game' });
    expect(first.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(await git.status()).toMatchObject({
      clean: true,
      head: first.oid,
    });
    expect(await git.log()).toMatchObject([
      { oid: first.oid, message: 'initial game\n' },
    ]);

    await git.createBranch('feature');
    await fs.write('src/index.ts', encoder.encode('export const value = 2;\n'));
    expect((await git.diff()).files).toMatchObject([
      { path: 'src/index.ts', status: 'modified' },
    ]);
    await expect(git.checkout('feature')).rejects.toMatchObject({
      code: 'GIT_CHECKOUT_DIRTY',
    });
    await fs.write('src/index.ts', encoder.encode('export const value = 1;\n'));
    await git.checkout('feature');
    expect(decoder.decode(await fs.read('src/index.ts'))).toBe(
      'export const value = 1;\n'
    );

    const repository = await git.exportRepository();
    const migratedFs = new MemoryFileSystem();
    const migrated = new PortableGitBackend(migratedFs);
    await migrated.importRepository(repository);
    expect(await migrated.log()).toMatchObject([
      { oid: first.oid, message: 'initial game\n' },
    ]);
    expect((await migrated.branches()).names).toEqual(['feature', 'main']);
  });

  it('reads a repository and index created by real Git', async () => {
    const root = await repositoryRoot();
    await writeFile(join(root, 'app.ts'), 'export const ok = true;\n');
    await exec('git', ['add', 'app.ts'], { cwd: root });
    await exec('git', ['commit', '-qm', 'real git commit'], { cwd: root });
    await exec('git', ['gc', '--prune=now'], { cwd: root });
    expect(
      (await readdir(join(root, '.git/objects/pack'))).some((name) =>
        name.endsWith('.pack')
      )
    ).toBe(true);
    await writeFile(join(root, 'app.ts'), 'export const ok = false;\n');
    await writeFile(join(root, 'new.txt'), 'untracked\n');

    const git = new PortableGitBackend(
      new NodeHostFileSystem(root, () => 1_700_000_000_000)
    );
    expect(await git.repository()).toMatchObject({
      branch: 'main',
      objectFormat: 'sha1',
    });
    expect(await git.log()).toMatchObject([
      { message: 'real git commit\n' },
    ]);
    expect(await git.status()).toMatchObject({
      unstaged: [{ path: 'app.ts', worktree: 'modified' }],
      untracked: ['new.txt'],
      clean: false,
    });
  });

  it('writes Git-compatible objects, refs and index accepted by real Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-portable-git-'));
    roots.push(root);
    const fs = new NodeHostFileSystem(root, () => 1_700_000_000_000);
    const git = new PortableGitBackend(fs, {
      now: () => 1_700_000_000_000,
      defaultAuthor: {
        name: 'TinyAI',
        email: 'tinyai@example.test',
        timezone: '+0000',
      },
    });
    await git.init({ initialBranch: 'main' });
    await fs.write('hello.txt', encoder.encode('hello\n'));
    await git.add(['hello.txt']);
    await git.commit({ message: 'portable commit' });

    await expect(exec('git', ['fsck', '--strict'], { cwd: root })).resolves.toBeDefined();
    const status = await exec('git', ['status', '--porcelain=v1'], { cwd: root });
    expect(status.stdout).toBe('');
    const log = await exec('git', ['log', '--format=%s'], { cwd: root });
    expect(log.stdout.trim()).toBe('portable commit');
    expect(await readFile(join(root, 'hello.txt'), 'utf8')).toBe('hello\n');
  });
});

async function repositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tinyai-git-oracle-'));
  roots.push(root);
  await exec('git', ['init', '-q', '-b', 'main'], { cwd: root });
  await exec('git', ['config', 'user.name', 'Git Oracle'], { cwd: root });
  await exec('git', ['config', 'user.email', 'oracle@example.test'], { cwd: root });
  return root;
}
