import { describe, expect, it } from 'vitest';
import {
  ExtensionRegistry,
  expandSkill,
} from '../../src/core/extension-registry';

describe('ExtensionRegistry', () => {
  it('resolves skills, commands, MCP, themes and hooks from arbitrary manifests', () => {
    const registry = new ExtensionRegistry();
    registry.register({
      id: 'builtin.core',
      name: 'Core',
      version: '1.0.0',
      source: 'builtin',
      skills: [
        {
          name: 'summarize',
          description: 'Summarize input',
          body: 'Summarize $ARGUMENTS with $1',
        },
      ],
      commands: [{ name: 'plan', description: 'create plan', prompt: 'Plan this' }],
      mcpServers: [{ name: 'docs', transport: 'http', url: 'https://example.com/mcp' }],
      themes: [{ name: 'forest', variables: { '--fg': '#123' } }],
      hooks: [
        {
          name: 'guard',
          event: 'PreToolUse',
          run: () => ({ decision: 'allow' }),
        },
      ],
    });
    expect(expandSkill(registry.skill('summarize')!, 'alpha beta')).toBe(
      'Summarize alpha beta with alpha'
    );
    expect(registry.command('plan')).toMatchObject({ prompt: 'Plan this' });
    expect(registry.mcpServer('docs')).toMatchObject({ transport: 'http' });
    expect(registry.theme('forest')?.variables['--fg']).toBe('#123');
    expect(registry.hooks()).toHaveLength(1);
    expect(registry.diagnostics()[0].contributions).toEqual({
      skill: 1,
      command: 1,
      mcp: 1,
      hook: 1,
      theme: 1,
    });
  });

  it('applies source precedence and rejects untrusted external manifests', () => {
    const registry = new ExtensionRegistry();
    registry.register({
      id: 'builtin',
      name: 'Builtin',
      version: '1',
      source: 'builtin',
      themes: [{ name: 'main', variables: { '--fg': 'builtin' } }],
    });
    registry.register({
      id: 'project',
      name: 'Project',
      version: '1',
      source: 'project',
      trusted: true,
      themes: [{ name: 'main', variables: { '--fg': 'project' } }],
    });
    expect(registry.theme('main')?.variables['--fg']).toBe('project');
    expect(() =>
      registry.register({
        id: 'untrusted',
        name: 'Untrusted',
        version: '1',
        source: 'plugin',
      })
    ).toThrowError(/must be explicitly trusted/);
  });
});
