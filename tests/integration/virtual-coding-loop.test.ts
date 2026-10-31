import { describe, expect, it } from 'vitest';
import { createVirtualWorkspaceTools } from '../../src/adapters/virtual-workspace-tools';
import { PermissionModeRegistry, PolicyEngine } from '../../src/core/policy';
import { SequentialIdGenerator, ToolExecutor } from '../../src/core';
import { WorkspaceRuntime } from '../../src/core/workspace-runtime';
import { MemoryHostBridge } from '../../src/host';
import {
  VirtualShell,
  VirtualWorkspace,
  type VirtualCommandProvider,
} from '../../src/virtual';
import {
  FakeApproval,
  events,
  text,
  toolCall,
} from '../harness/fakes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('portable virtual coding loop', () => {
  it('searches, patches and verifies a failing project without host Bash or filesystem', async () => {
    const workspace = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'benchmark:virtual-loop',
    });
    await workspace.fs.write(
      'src/math.ts',
      encoder.encode('export function add(a: number, b: number) { return a - b; }\n')
    );
    await workspace.fs.write(
      'README.md',
      encoder.encode('# fixture\nRun `check` before completion.\n')
    );
    const checker: VirtualCommandProvider = {
      canExecute: (command) => command === 'check',
      async execute() {
        const text = decoder.decode(await workspace.fs.read('src/math.ts'));
        return text.includes('return a + b;')
          ? { exitCode: 0, stdout: 'math fixture passed\n', stderr: '' }
          : { exitCode: 1, stdout: '', stderr: 'addition regression\n' };
      },
    };
    workspace.shell.addProvider(checker);
    const modes = new PermissionModeRegistry('sandbox-auto', () => 10);
    const tools = new ToolExecutor(
      createVirtualWorkspaceTools(workspace),
      new FakeApproval(true),
      { policy: new PolicyEngine((sessionId) => modes.mode(sessionId)) }
    );
    let call = 0;
    const model = {
      async *stream() {
        const index = call++;
        if (index === 0) {
          yield* events(
            ...toolCall('search_1', 'search', {
              pattern: 'return a - b',
              include: ['**/*.ts'],
            })
          );
        } else if (index === 1) {
          yield* events(
            ...toolCall('patch_1', 'apply_patch', {
              patch: [
                '--- a/src/math.ts',
                '+++ b/src/math.ts',
                '@@ -1,1 +1,1 @@',
                '-export function add(a: number, b: number) { return a - b; }',
                '+export function add(a: number, b: number) { return a + b; }',
                '',
              ].join('\n'),
            })
          );
        } else if (index === 2) {
          yield* events(...toolCall('exec_1', 'exec', { script: 'check' }));
        } else {
          yield* events(...text('Fixed addition and verified the math fixture.'));
        }
      },
    };
    const runtime = new WorkspaceRuntime({
      model,
      tools,
      clock: { now: () => 10, setTimeout: () => 1, clearTimeout: () => undefined },
      ids: new SequentialIdGenerator(),
      permissionModes: modes,
      maxSteps: 10,
      completionGuard: ({ view }) => ({
        ok: view.rows.some(
          (row) =>
            row.kind === 'tool' &&
            row.toolName === 'exec' &&
            row.status === 'completed'
        ),
        reason: 'A successful verification command is required',
      }),
    });
    const ack = await runtime.command({
      commandId: 'benchmark-command',
      clientId: 'benchmark',
      sessionId: 'benchmark-session',
      type: 'send_input',
      payload: { text: 'Fix the failing addition and verify it.' },
      issuedAt: 10,
    });
    expect(ack.status).toBe('accepted');
    await runtime.waitForSessionIdle('benchmark-session');
    const projection = runtime.getProjection('benchmark-session');
    expect(projection.taskStatus).toBe('completed');
    expect(
      projection.rows
        .filter((row) => row.kind === 'tool')
        .map((row) => [row.toolName, row.status])
    ).toEqual([
      ['search', 'completed'],
      ['apply_patch', 'completed'],
      ['exec', 'completed'],
    ]);
    expect(decoder.decode(await workspace.fs.read('src/math.ts'))).toContain(
      'return a + b;'
    );
    await workspace.jobs.dispose();
  });
});
