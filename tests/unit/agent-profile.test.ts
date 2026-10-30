import { describe, expect, it } from 'vitest';
import type { AgentProfile, ChildTaskSpec } from '../../src/core/agent-profile';
import { AgentProfileRegistry } from '../../src/core/agent-profile';

function profile(
  name: string,
  source: AgentProfile['source'],
  overrides: Partial<AgentProfile> = {}
): AgentProfile {
  return {
    name,
    displayName: name,
    description: `${name} profile`,
    instructions: `Act as ${name}`,
    source,
    skills: [],
    tools: {},
    mcpServers: [],
    permissions: {
      capabilities: ['browser:read', 'browser:interact'],
      effects: ['read', 'write'],
    },
    contextMode: 'fresh',
    execution: {
      defaultMode: 'foreground',
      allowedModes: ['foreground', 'background', 'isolated-worktree', 'sandbox'],
    },
    maxDepth: 2,
    maxConcurrency: 2,
    ...overrides,
  };
}

function child(profileName: string): ChildTaskSpec {
  return {
    parentTaskId: 'task_parent',
    profile: profileName,
    brief: 'Inspect this exact page',
    budget: { maxTurns: 4 },
    contextMode: 'fresh',
    executionMode: 'foreground',
  };
}

describe('AgentProfileRegistry', () => {
  it('supports arbitrary profile names without a fixed role enum', () => {
    const registry = new AgentProfileRegistry();
    registry.register(profile('browser-auditor', 'builtin'));
    registry.register(profile('docs-verifier', 'plugin'));
    expect(registry.get('browser-auditor')).toMatchObject({ instructions: 'Act as browser-auditor' });
    expect(registry.get('docs-verifier')).toMatchObject({ instructions: 'Act as docs-verifier' });
  });

  it('merges sources by fixed precedence and reports provenance', () => {
    const registry = new AgentProfileRegistry();
    registry.register(profile('inspect', 'builtin'));
    registry.register(profile('inspect', 'user', { displayName: 'User inspect' }));
    registry.register(profile('inspect', 'project', { displayName: 'Project inspect' }));
    expect(registry.get('inspect')?.displayName).toBe('Project inspect');
    expect(registry.diagnostics()).toEqual([
      { name: 'inspect', source: 'builtin', effective: false },
      { name: 'inspect', source: 'user', effective: false },
      { name: 'inspect', source: 'project', effective: true },
    ]);
  });

  it('never grants capabilities outside the parent permission set', () => {
    const registry = new AgentProfileRegistry();
    registry.register(profile('writer', 'plugin'));
    const resolved = registry.resolve('writer', {
      capabilities: ['browser:read'],
      effects: ['read', 'network'],
      deniedTools: ['evaluate'],
    });
    expect(resolved.effectivePermissions).toEqual({
      capabilities: ['browser:read'],
      effects: ['read'],
      deniedCapabilities: [],
      deniedTools: ['evaluate'],
    });
  });

  it('validates arbitrary child specs against depth, concurrency, mode and budget', () => {
    const registry = new AgentProfileRegistry();
    registry.register(profile('worker', 'project'));
    expect(registry.validateChild(child('worker'), { depth: 0, maxDepth: 2, concurrency: 0 })).toMatchObject({
      requestedName: 'worker',
      registryRevision: 1,
    });
    expect(() =>
      registry.validateChild(child('worker'), { depth: 2, maxDepth: 3, concurrency: 0 })
    ).toThrowError(/depth exceeds/);
    expect(() =>
      registry.validateChild(
        { ...child('worker'), budget: { maxTurns: 0 } },
        { depth: 0, maxDepth: 2, concurrency: 0 }
      )
    ).toThrowError(/must be positive/);
    expect(() =>
      registry.validateChild(
        { ...child('worker'), executionMode: 'background' },
        { depth: 0, maxDepth: 2, concurrency: 2 }
      )
    ).toThrowError(/at most 2 concurrent/);
  });

  it('rejects profile definitions that could grant unallowed execution', () => {
    const registry = new AgentProfileRegistry();
    expect(() =>
      registry.register(
        profile('broken', 'user', {
          execution: { defaultMode: 'sandbox', allowedModes: ['foreground'] },
        })
      )
    ).toThrowError(/default execution mode must be allowed/);
  });
});
