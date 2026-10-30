import { describe, expect, it } from 'vitest';
import type { ToolDefinition } from '../../src/core';
import { ToolRegistry } from '../../src/core/tool-registry';

function tool(name: string, capabilities: string[] = []): ToolDefinition {
  return {
    name,
    description: name,
    parameters: { type: 'object', properties: {} },
    risk: 'read',
    capabilities,
    execute: async () => name,
  };
}

describe('ToolRegistry', () => {
  it('resolves arbitrary tool sets by allow, deny and capability', () => {
    const registry = new ToolRegistry();
    registry.register({ definition: tool('read', ['browser:read']), source: 'builtin' });
    registry.register({ definition: tool('click', ['browser:write']), source: 'builtin' });
    registry.register({ definition: tool('shell', ['sandbox:execute']), source: 'plugin' });

    expect(registry.resolve().map((item) => item.name)).toEqual(['click', 'read', 'shell']);
    expect(
      registry.resolve({ allow: ['read', 'click'], deny: ['click'] }).map((item) => item.name)
    ).toEqual(['read']);
    expect(registry.resolve({ capabilities: ['browser:write'] }).map((item) => item.name)).toEqual([
      'click',
    ]);
  });

  it('uses a fixed source precedence without coupling the core to a role list', () => {
    const registry = new ToolRegistry();
    registry.register({ definition: tool('inspect'), source: 'builtin' });
    registry.register({ definition: tool('inspect'), source: 'project', sourceId: 'repo-a' });
    registry.register({ definition: tool('inspect'), source: 'user' });
    expect(registry.get('inspect')).toBeDefined();
    expect(registry.diagnostics()).toEqual([
      { name: 'inspect', source: 'project', sourceId: 'repo-a', enabled: true },
    ]);

    registry.clearSource('project', 'repo-a');
    expect(registry.diagnostics()[0]).toMatchObject({ name: 'inspect', source: 'user' });
  });

  it('excludes disabled registrations from model descriptors', () => {
    const registry = new ToolRegistry();
    registry.register({ definition: tool('enabled'), source: 'builtin' });
    registry.register({ definition: tool('disabled'), source: 'builtin', enabled: false });
    expect(registry.resolve().map((item) => item.name)).toEqual(['enabled']);
  });
});
