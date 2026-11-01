import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NpmScriptActionProvider } from '../../src/adapters/npm-action-provider';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('NpmScriptActionProvider', () => {
  it('exposes only configured npm scripts and returns structured output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-npm-action-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          check: 'node -e "console.log(\'action-ok\')"',
        },
      })
    );
    const provider = new NpmScriptActionProvider({
      workspaceRoot: root,
      scripts: [
        {
          id: 'app.game.check',
          title: 'Check game',
          description: 'Run the game check script.',
          script: 'check',
        },
      ],
    });
    const descriptors = await provider.describe();
    expect(descriptors.map((item) => item.id)).toEqual(['app.game.check']);
    expect(
      await descriptors[0].probe()
    ).toMatchObject({ state: 'available' });
    const result = await provider.invoke(
      'app.game.check',
      {},
      {
        sessionId: 'session',
        taskId: 'task',
        signal: new AbortController().signal,
      }
    );
    expect(result).toMatchObject({
      value: {
        actionId: 'app.game.check',
        exitCode: 0,
        stdout: expect.stringContaining('action-ok'),
      },
    });
  });

  it('does not expose arbitrary commands', async () => {
    const provider = new NpmScriptActionProvider({
      workspaceRoot: process.cwd(),
      scripts: [],
    });
    expect(await provider.describe()).toEqual([]);
  });

  it('returns failed TestEvidence-ready results without discarding failure output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-npm-action-fail-'));
    roots.push(root);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({
        private: true,
        scripts: {
          test: 'node -e "console.error(\'failed-case\'); process.exit(1)"',
        },
      })
    );
    const provider = new NpmScriptActionProvider({
      workspaceRoot: root,
      scripts: [
        {
          id: 'app.tests.run',
          title: 'Run tests',
          description: 'Run tests.',
          script: 'test',
          testRunner: 'node',
        },
      ],
    });
    const descriptors = await provider.describe();
    expect(descriptors[0].test).toEqual({ runner: 'node' });
    const result = await provider.invoke('app.tests.run', {}, {
      sessionId: 's',
      taskId: 't',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'failed',
      exitCode: 1,
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          name: 'app.tests.run-stderr.bin',
          kind: 'binary',
        }),
      ]),
    });
  });
});
