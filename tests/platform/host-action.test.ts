import { describe, expect, it, vi } from 'vitest';
import {
  assertActionWorkspaceBinding,
  createHostActionTools,
} from '../../src/adapters/host-action-tools';
import { ToolExecutor } from '../../src/core/tool-executor';
import { PermissionModeRegistry, PolicyEngine } from '../../src/core/policy';
import {
  HostActionRegistry,
  type HostActionDescriptor,
  type HostActionProvider,
} from '../../src/platform/host-action';
import { FakeApproval } from '../harness/fakes';
import { createWorkspaceCapabilityComposition } from '../../src/runtime/workspace-capability-composition';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';

function descriptor(
  overrides: Partial<HostActionDescriptor> = {}
): HostActionDescriptor {
  return {
    id: 'app.python.run-tests',
    version: '1.0.0',
    title: 'Run Python tests',
    description: 'Run the application test suite.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
      },
    },
    effects: ['execute'],
    risk: 'dangerous',
    probe: async () => ({ state: 'available' }),
    ...overrides,
  };
}

function provider(
  actions: readonly HostActionDescriptor[],
  invoke: HostActionProvider['invoke'] = vi.fn(async () => ({
    value: { passed: true },
  }))
): HostActionProvider {
  return {
    describe: async () => actions,
    invoke,
  };
}

describe('HostActionRegistry', () => {
  it('discovers available actions and preserves structured invocation context', async () => {
    const invoke = vi.fn(async () => ({
      value: { passed: true },
      artifactIds: ['artifact_1'],
    }));
    const registry = new HostActionRegistry();
    registry.register('python-app', provider([descriptor()], invoke));
    const controller = new AbortController();

    const report = await registry.discover(controller.signal);
    expect(report.diagnostics).toEqual([]);
    expect(report.available[0]).toMatchObject({
      sourceId: 'python-app',
      descriptor: { id: 'app.python.run-tests', version: '1.0.0' },
      probe: { state: 'available' },
    });

    await expect(
      registry.invoke('app.python.run-tests', { pattern: 'unit' }, {
        sessionId: 'session_1',
        taskId: 'task_1',
        workspacePath: 'apps/server',
        signal: controller.signal,
      })
    ).resolves.toMatchObject({
      value: { passed: true },
      artifactIds: ['artifact_1'],
      status: 'succeeded',
    });
    expect(invoke).toHaveBeenCalledWith(
      'app.python.run-tests',
      { pattern: 'unit' },
      expect.objectContaining({
        sessionId: 'session_1',
        taskId: 'task_1',
        workspacePath: 'apps/server',
      })
    );
  });

  it('rejects duplicate ids and invalid schemas without falling back to exec', async () => {
    const registry = new HostActionRegistry();
    registry.register('first', provider([descriptor()]));
    registry.register('second', provider([descriptor()]));
    registry.register(
      'invalid',
      provider([
        descriptor({
          id: 'app.invalid-schema',
          inputSchema: { type: 'string' },
        }),
      ])
    );

    const report = await registry.discover();
    expect(report.available).toHaveLength(1);
    expect(report.diagnostics.map((item) => item.code).sort()).toEqual([
      'ACTION_DUPLICATE',
      'ACTION_SCHEMA_INVALID',
    ]);
    await expect(
      registry.invoke('app.invalid-schema', {}, {
        sessionId: 's',
        taskId: 't',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_UNAVAILABLE' });
  });

  it('marks failed probes unavailable and supports cancellation', async () => {
    const registry = new HostActionRegistry();
    registry.register(
      'app',
      provider([
        descriptor({
          probe: async () => ({
            state: 'unavailable',
            reason: 'Python runtime unavailable',
          }),
        }),
      ])
    );
    const report = await registry.discover();
    expect(report.available).toEqual([]);
    expect(report.inspected[0]).toMatchObject({
      descriptor: { id: 'app.python.run-tests' },
      probe: { state: 'unavailable' },
    });
    expect(report.diagnostics[0]).toMatchObject({
      code: 'ACTION_PROBE_FAILED',
      message: 'Python runtime unavailable',
    });

    const controller = new AbortController();
    controller.abort();
    await expect(registry.discover(controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('generates discoverable tool definitions with stable names and effects', async () => {
    const registry = new HostActionRegistry();
    const invoke = vi.fn(async () => ({ value: { ok: true } }));
    registry.register('python-app', provider([descriptor()], invoke));
    const tools = await createHostActionTools(registry, {
      workspacePath: 'game',
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      'list_host_actions',
      'action_app_python_run_tests',
    ]);
    const action = tools[1];
    expect(action).toMatchObject({
      risk: 'dangerous',
      effect: 'execute',
      replay: 'never',
    });
    const invocation = {
      sessionId: 'session_1',
      taskId: 'task_1',
      call: {
        id: 'call_1',
        name: action.name,
        arguments: '{"pattern":"unit"}',
      },
      signal: new AbortController().signal,
    };
    await expect(
      action.execute({ pattern: 'unit' }, invocation)
    ).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(
      'app.python.run-tests',
      { pattern: 'unit' },
      expect.objectContaining({
        workspacePath: 'game',
        requestId: 'call_1',
      })
    );
  });

  it('validates input again at the registry boundary and exposes lifecycle hooks', async () => {
    const dispose = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const registry = new HostActionRegistry();
    registry.register('python-app', {
      ...provider([
        descriptor({
          inputSchema: {
            type: 'object',
            properties: { pattern: { type: 'string' } },
            required: ['pattern'],
          },
        }),
      ]),
      cancel,
      dispose,
    });
    await expect(
      registry.invoke('app.python.run-tests', {}, {
        sessionId: 's',
        taskId: 't',
        signal: new AbortController().signal,
      })
    ).rejects.toMatchObject({ code: 'ACTION_INPUT_INVALID' });
    await registry.cancel('request_1');
    expect(cancel).toHaveBeenCalledWith('request_1');
    await registry.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('routes dangerous Actions through the shared approval gate without exec fallback', async () => {
    const invoke = vi.fn(async () => ({ value: { passed: true } }));
    const registry = new HostActionRegistry();
    registry.register('python-app', provider([descriptor()], invoke));
    const tools = await createHostActionTools(registry);
    const denied = new ToolExecutor(tools, new FakeApproval(false));
    const deniedResult = await denied.execute({
      sessionId: 's',
      taskId: 't',
      call: {
        id: 'call_denied',
        name: 'action_app_python_run_tests',
        arguments: '{"pattern":"unit"}',
      },
      signal: new AbortController().signal,
    });
    expect(deniedResult).toMatchObject({ status: 'denied' });
    expect(invoke).not.toHaveBeenCalled();

    const approved = new ToolExecutor(tools, new FakeApproval(true));
    await expect(
      approved.execute({
        sessionId: 's',
        taskId: 't',
        call: {
          id: 'call_approved',
          name: 'action_app_python_run_tests',
          arguments: '{"pattern":"unit"}',
        },
        signal: new AbortController().signal,
      })
    ).resolves.toMatchObject({ status: 'succeeded' });
    expect(invoke).toHaveBeenCalledOnce();
  });

  it('binds approval digests to Action input and environment context', async () => {
    const registry = new HostActionRegistry();
    registry.register('python-app', provider([descriptor()]));
    let generation = 7;
    const tools = await createHostActionTools(registry, {
      workspaceId: 'workspace_1',
      workspaceGeneration: () => generation,
      environmentFingerprint: 'environment-a',
    });
    const approval = new FakeApproval(true);
    const modes = new PermissionModeRegistry('guarded');
    const executor = new ToolExecutor(tools, approval, {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
    });
    for (const [id, pattern] of [
      ['call_1', 'unit'],
      ['call_2', 'integration'],
    ] as const) {
      await executor.execute({
        sessionId: 'session',
        taskId: 'task',
        call: {
          id,
          name: 'action_app_python_run_tests',
          arguments: JSON.stringify({ pattern }),
        },
        signal: new AbortController().signal,
      });
    }
    expect(approval.requests).toHaveLength(2);
    expect(approval.requests[0].actionDigest).toBeTruthy();
    expect(approval.requests[0].actionDigest).not.toBe(
      approval.requests[1].actionDigest
    );
    generation = 8;
    await executor.execute({
      sessionId: 'session',
      taskId: 'task',
      call: {
        id: 'call_3',
        name: 'action_app_python_run_tests',
        arguments: JSON.stringify({ pattern: 'integration' }),
      },
      signal: new AbortController().signal,
    });
    expect(approval.requests[2].actionDigest).not.toBe(
      approval.requests[1].actionDigest
    );
  });

  it('re-discovers provider versions before each invocation', async () => {
    let version = '1.0.0';
    const registry = new HostActionRegistry();
    registry.register('python-app', {
      describe: async () => [descriptor({ version })],
      invoke: async () => ({ value: { version } }),
    });
    expect((await registry.list())[0].descriptor.version).toBe('1.0.0');
    version = '1.1.0';
    expect((await registry.list())[0].descriptor.version).toBe('1.1.0');
  });

  it('suppresses duplicate side effects for required idempotency scopes', async () => {
    const invoke = vi.fn(async () => ({ value: { ok: true } }));
    const registry = new HostActionRegistry();
    registry.register('app', {
      describe: async () => [
        descriptor({
          id: 'app.write-result',
          idempotency: 'required',
          effects: ['write'],
          risk: 'write',
        }),
      ],
      invoke,
    });
    const context = {
      sessionId: 'session',
      taskId: 'task',
      requestId: 'request_1',
      idempotencyKey: 'same-scope',
      workspaceId: 'workspace',
      workspaceGeneration: 1,
      environmentFingerprint: 'env-a',
      signal: new AbortController().signal,
    };
    const first = await registry.invoke('app.write-result', {}, context);
    const second = await registry.invoke('app.write-result', {}, {
      ...context,
      requestId: 'request_2',
    });
    expect(invoke).toHaveBeenCalledOnce();
    expect(first.replayed).toBeUndefined();
    expect(second.replayed).toBe(true);

    await registry.invoke('app.write-result', {}, {
      ...context,
      requestId: 'request_3',
      workspaceGeneration: 2,
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('maps Provider result metadata and binary artifacts into detailed Tool output', async () => {
    const registry = new HostActionRegistry();
    const binary = new Uint8Array([0, 9, 255]);
    registry.register(
      'app',
      provider([descriptor({ version: '2.3.0' })], async () => ({
        value: { ok: true },
        status: 'succeeded',
        durationMs: 17,
        exitCode: 3,
        truncated: true,
        artifactIds: ['provider_artifact'],
        artifacts: [
          {
            name: 'result.bin',
            mimeType: 'application/octet-stream',
            kind: 'binary',
            data: binary,
          },
        ],
      }))
    );
    const tools = await createHostActionTools(registry);
    const detailed = await tools[1].executeDetailed!(
      { pattern: 'unit' },
      {
        sessionId: 'session',
        taskId: 'task',
        call: {
          id: 'call',
          name: 'action_app_python_run_tests',
          arguments: '{"pattern":"unit"}',
        },
        signal: new AbortController().signal,
      }
    );
    expect(detailed).toMatchObject({
      value: { ok: true },
      metadata: {
        status: 'succeeded',
        action: {
          id: 'app.python.run-tests',
          version: '2.3.0',
          sourceId: 'app',
        },
        durationMs: 17,
        exitCode: 3,
        truncated: true,
        artifactIds: ['provider_artifact'],
      },
      attachments: [
        {
          name: 'result.bin',
          mimeType: 'application/octet-stream',
          kind: 'binary',
          data: binary,
        },
      ],
    });
  });

  it('rejects root-only Actions in child workspaces and supports fork bindings', () => {
    expect(() =>
      assertActionWorkspaceBinding(true, descriptor({ workspaceBinding: 'root' }))
    ).toThrowError(/not fork-bound/);
    expect(() =>
      assertActionWorkspaceBinding(true, descriptor({ workspaceBinding: 'fork' }))
    ).not.toThrow();
    expect(() =>
      assertActionWorkspaceBinding(false, descriptor({ workspaceBinding: 'root' }))
    ).not.toThrow();
  });

  it('rejects an approval when generation changes before execution', async () => {
    let generation = 1;
    const registry = new HostActionRegistry();
    registry.register('app', provider([descriptor({ effects: ['write'] })]));
    const tools = await createHostActionTools(registry, {
      workspaceId: 'child_workspace',
      bindingForInvocation: () => ({
        workspaceId: 'child_workspace',
        workspaceGeneration: generation,
      }),
    });
    const approval = new FakeApproval(() => {
      generation = 2;
      return true;
    });
    const executor = new ToolExecutor(tools, approval, {
      policy: new PolicyEngine(() => 'guarded'),
    });
    const result = await executor.execute({
      sessionId: 'child_session',
      taskId: 'child_task',
      call: {
        id: 'call_stale',
        name: 'action_app_python_run_tests',
        arguments: '{"pattern":"unit"}',
      },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'ACTION_APPROVAL_STALE' },
    });
  });

  it('keeps Chrome-style shared packs separate from browser-only tools', async () => {
    const workspace = new VirtualWorkspace({ host: new MemoryHostBridge() });
    const shared = await createWorkspaceCapabilityComposition({
      workspace,
      profile: 'portable',
      hostProfile: 'browser-agent',
    });
    const names = shared.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['read_file', 'apply_patch', 'git_status', 'code_symbols'])
    );
    expect(names).not.toEqual(
      expect.arrayContaining(['list_tabs', 'switch_tab', 'open_page'])
    );
  });
});
