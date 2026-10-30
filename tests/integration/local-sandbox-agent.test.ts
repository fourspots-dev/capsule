import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSandboxTools } from '../../src/adapters/sandbox-tools';
import {
  PermissionModeRegistry,
  PolicyEngine,
  SequentialIdGenerator,
  ToolExecutor,
  Verifier,
  WorkspaceRuntime,
} from '../../src/core';
import { MacOSSeatbeltSandbox } from '../../src/node/macos-sandbox';
import { FakeApproval, FakeClock, FakeModelTransport, events, text, toolCall } from '../harness/fakes';
import { command } from '../harness/workspace';

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe.skipIf(!onMac)('local coding agent E2E', () => {
  it('writes and verifies code in a real macOS Seatbelt workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'tinyai-agent-local-'));
    await writeFile(
      join(workspace, 'package.json'),
      JSON.stringify({
        scripts: {
          test:
            'node -e "const fs=require(\'fs\');process.exit(fs.readFileSync(\'result.txt\',\'utf8\').trim()===\'done\'?0:1)"',
        },
      })
    );
    const sandbox = new MacOSSeatbeltSandbox({ defaultTimeoutMs: 10_000 });
    const lease = await sandbox.createWorkspace({
      sessionId: 'local-agent',
      workspaceRoot: workspace,
    });
    try {
      const modes = new PermissionModeRegistry('sandbox-auto');
      const tools = new ToolExecutor(createSandboxTools(sandbox, lease), new FakeApproval(true), {
        policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
      });
      const model = new FakeModelTransport(async (_request, index) => {
        if (index === 0) {
          return events(
            ...toolCall('write_1', 'write_file', {
              path: 'result.txt',
              text: 'done\n',
            })
          );
        }
        if (index === 1) {
          return events(...toolCall('test_1', 'run_tests', { command: 'npm', args: ['test'] }));
        }
        return events(...text('Local sandbox implementation verified.'));
      });
      const runtime = new WorkspaceRuntime({
        model,
        tools,
        clock: new FakeClock(),
        ids: new SequentialIdGenerator(),
      });
      await runtime.command(command('local-agent', 'command_1', 'implement and test'));
      await runtime.waitForSessionIdle('local-agent');
      expect(runtime.getProjection('local-agent').taskStatus).toBe('completed');
      expect(
        new TextDecoder().decode((await sandbox.readFile(lease, 'result.txt')).data)
      ).toBe('done\n');

      const verifier = new Verifier({
        run: async (verification, signal) => {
          const result = await sandbox.exec(lease, {
            command: verification.command,
            args: verification.args,
            signal,
          });
          return {
            exitCode: result.exitCode,
            output: `${result.stdout}${result.stderr}`,
            durationMs: result.durationMs,
          };
        },
      });
      await expect(
        verifier.assertComplete([{ name: 'tests', command: 'npm', args: ['test'] }])
      ).resolves.toMatchObject({ status: 'passed' });
    } finally {
      await sandbox.release(lease);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
