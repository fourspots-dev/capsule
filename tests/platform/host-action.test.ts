import { describe, expect, it, vi } from 'vitest';
import { createHostActionTools } from '../../src/adapters/host-action-tools';
import {
  HostActionRegistry,
  type HostActionDescriptor,
  type HostActionProvider,
} from '../../src/platform/host-action';

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
    ).resolves.toEqual({
      value: { passed: true },
      artifactIds: ['artifact_1'],
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
      expect.objectContaining({ workspacePath: 'game' })
    );
  });
});
