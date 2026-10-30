import { describe, expect, it, vi } from 'vitest';
import {
  AgentProfileRegistry,
  type AgentProfile,
  type ChildTaskSpec,
} from '../../src/core/agent-profile';
import {
  SubagentCoordinator,
  type ChildDriver,
  type ChildResult,
} from '../../src/core/subagent-coordinator';
import { SequentialIdGenerator } from '../../src/core/ports';

function profile(name: string, overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    name,
    displayName: name,
    description: name,
    instructions: name,
    source: 'builtin',
    skills: [],
    tools: {},
    mcpServers: [],
    permissions: {
      capabilities: ['browser:read'],
      effects: ['read'],
    },
    contextMode: 'fresh',
    execution: {
      defaultMode: 'background',
      allowedModes: ['foreground', 'background'],
    },
    maxDepth: 2,
    maxConcurrency: 4,
    ...overrides,
  };
}

function spec(executionMode: ChildTaskSpec['executionMode']): ChildTaskSpec {
  return {
    parentTaskId: 'parent_1',
    profile: 'custom',
    brief: 'Inspect exactly this',
    budget: { maxTurns: 2 },
    contextMode: 'fresh',
    executionMode,
  };
}

function driver(run: ChildDriver['run']): ChildDriver {
  return {
    create: vi.fn(async ({ taskId }) => ({ sessionId: `session_${taskId}` })),
    run,
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    projection: vi.fn(() => undefined),
    resume: vi.fn(async () => result('completed')),
  };
}

function result(status: ChildResult['status']): ChildResult {
  return {
    status,
    summary: status,
    artifacts: [],
    unresolved: [],
  };
}

function coordinator(childDriver: ChildDriver) {
  const registry = new AgentProfileRegistry();
  registry.register(profile('custom'));
  registry.register(profile('other'));
  return new SubagentCoordinator({
    registry,
    driver: childDriver,
    ids: new SequentialIdGenerator(),
    now: () => 10,
  });
}

const parent = {
  taskId: 'parent_1',
  depth: 0,
  maxDepth: 2,
  permissions: {
    capabilities: ['browser:read', 'browser:interact'],
    effects: ['read', 'write'] as Array<'read' | 'write'>,
  },
};

describe('SubagentCoordinator', () => {
  it('spawns an arbitrary profile in the background and returns a structured result', async () => {
    const driverMock = driver(async () => result('completed'));
    const coordinatorMock = coordinator(driverMock);
    const spawned = await coordinatorMock.spawn(spec('background'), parent);
    expect(spawned).toMatchObject({
      profileName: 'custom',
      status: 'running',
      sessionId: expect.stringContaining('session_child_task_1'),
    });
    await expect(coordinatorMock.wait(spawned.taskId)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(driverMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('Inspect exactly this'),
      })
    );
    await coordinatorMock.dispose();
  });

  it('blocks foreground completion until the child finishes', async () => {
    const driverMock = driver(async () => result('completed'));
    const coordinatorMock = coordinator(driverMock);
    const spawned = await coordinatorMock.spawn(spec('foreground'), parent);
    expect(spawned.status).toBe('completed');
    expect(spawned.result?.summary).toBe('completed');
  });

  it('sends messages and recursively cancels owned children', async () => {
    let release!: () => void;
    const driverMock = driver(
      async () =>
        new Promise((resolve) => {
          release = () => resolve(result('completed'));
        })
    );
    const coordinatorMock = coordinator(driverMock);
    const first = await coordinatorMock.spawn(spec('background'), parent);
    await coordinatorMock.send(first.taskId, 'steer', 'guide');
    expect(driverMock.send).toHaveBeenCalledWith(first.taskId, 'steer', 'guide');
    await coordinatorMock.stop(first.taskId);
    await expect(coordinatorMock.wait(first.taskId)).resolves.toMatchObject({
      status: 'cancelled',
    });
    release();
    expect(coordinatorMock.list('parent_1')[0].status).toBe('cancelled');
  });

  it('enforces parent-permission intersection and max concurrency', async () => {
    const driverMock = driver(async () => result('completed'));
    const coordinatorMock = coordinator(driverMock);
    const first = await coordinatorMock.spawn(spec('background'), { ...parent, concurrency: 3 });
    await expect(
      coordinatorMock.spawn(spec('background'), { ...parent, concurrency: 4 })
    ).rejects.toMatchObject({ code: 'CHILD_CONCURRENCY_EXCEEDED' });
    expect(first.profileName).toBe('custom');
    await coordinatorMock.dispose();
  });

  it('rejects child results that do not satisfy the profile schema', async () => {
    const registry = new AgentProfileRegistry();
    registry.register(
      profile('schema', {
        resultSchema: {
          type: 'object',
          properties: { findings: { type: 'array' } },
          required: ['findings'],
        },
      })
    );
    const fakeDriver = driver(async () => ({
      status: 'completed',
      summary: 'done',
      output: { wrong: true },
      artifacts: [],
      unresolved: [],
    }));
    const coordinatorMock = new SubagentCoordinator({
      registry,
      driver: fakeDriver,
      ids: new SequentialIdGenerator(),
    });
    const spawned = await coordinatorMock.spawn(
      { ...spec('foreground'), profile: 'schema' },
      parent
    );
    expect(spawned).toMatchObject({
      status: 'failed',
      result: { error: { code: 'CHILD_RESULT_SCHEMA_INVALID' } },
    });
  });

  it('injects parent context only when fork mode is explicitly requested', async () => {
    const registry = new AgentProfileRegistry();
    registry.register(profile('forkable', {
      execution: {
        defaultMode: 'background',
        allowedModes: ['foreground', 'background'],
      },
    }));
    const driverMock = driver(async () => result('completed'));
    const coordinatorMock = new SubagentCoordinator({
      registry,
      driver: driverMock,
      ids: new SequentialIdGenerator(),
      contextProvider: async () => [
        { role: 'user', content: 'private parent marker' },
      ],
    });
    await coordinatorMock.spawn(
      {
        ...spec('background'),
        profile: 'forkable',
        contextMode: 'fork',
      },
      parent
    );
    expect(driverMock.create).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('private parent marker'),
      })
    );
    await coordinatorMock.dispose();
  });
});
