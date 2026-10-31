import { describe, expect, it } from 'vitest';
import { CapabilityGraph } from '../../src/platform/capability';
import { ToolPackComposer } from '../../src/platform/tool-pack';
import { readTool } from '../harness/fakes';

describe('ToolPackComposer', () => {
  it('composes tools solely from capability state', () => {
    const graph = new CapabilityGraph();
    graph.register({
      id: 'filesystem',
      version: '1',
      state: 'available',
      limitations: [],
    });
    graph.register({
      id: 'actions',
      version: '1',
      state: 'unavailable',
      limitations: ['No application provider'],
    });
    const composer = new ToolPackComposer();
    composer.register({
      id: 'workspace',
      requiredCapabilities: ['filesystem'],
      tools: [readTool('read_file')],
    });
    composer.register({
      id: 'actions',
      requiredCapabilities: ['actions'],
      tools: [readTool('action_app_check')],
    });
    const result = composer.compose(graph);
    expect(result.activated).toEqual(['workspace']);
    expect(result.tools.map((tool) => tool.name)).toEqual(['read_file']);
    expect(result.skipped).toEqual([
      {
        id: 'actions',
        reason: 'Missing required capabilities: actions',
      },
    ]);
    expect(result.capabilities.diagnostics[0]).toMatchObject({
      capabilityId: 'actions',
    });
  });

  it('supports alternative capabilities and rejects duplicate tool names', () => {
    const graph = new CapabilityGraph();
    graph.register({
      id: 'search-host',
      version: '1',
      state: 'degraded',
      limitations: ['No index'],
    });
    graph.register({
      id: 'filesystem',
      version: '1',
      state: 'available',
      limitations: [],
    });
    const composer = new ToolPackComposer();
    composer.register({
      id: 'search',
      requiresAny: ['search-host', 'filesystem'],
      tools: [readTool('search')],
    });
    expect(composer.compose(graph).activated).toEqual(['search']);

    composer.register({
      id: 'duplicate',
      tools: [readTool('search')],
    });
    expect(() => composer.compose(graph)).toThrow(
      'Duplicate tool name across packs: search'
    );
  });
});
