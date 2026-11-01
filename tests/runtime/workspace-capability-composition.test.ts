import { describe, expect, it } from 'vitest';
import { MemoryHostBridge } from '../../src/host';
import { HostActionRegistry } from '../../src/platform/host-action';
import {
  createWorkspaceCapabilityComposition,
  createWorkspaceCompletionGuard,
  evaluateCompletion,
} from '../../src/runtime/workspace-capability-composition';
import { VirtualWorkspace } from '../../src/virtual';

function workspace(): VirtualWorkspace {
  return new VirtualWorkspace({ host: new MemoryHostBridge() });
}

function actionRegistry(): HostActionRegistry {
  const registry = new HostActionRegistry();
  registry.register('app', {
    describe: async () => [
      {
        id: 'app.game.check',
        version: '1.0.0',
        title: 'Check game',
        description: 'Run app checks.',
        inputSchema: { type: 'object', properties: {} },
        effects: ['execute'],
        risk: 'dangerous',
        probe: async () => ({ state: 'available' }),
      },
    ],
    invoke: async () => ({ value: { passed: true } }),
  });
  return registry;
}

describe('workspace capability composition', () => {
  it('builds a shell-free Portable profile with Git and application Actions', async () => {
    const result = await createWorkspaceCapabilityComposition({
      workspace: workspace(),
      profile: 'portable',
      actionRegistry: actionRegistry(),
      hostProfile: 'tui',
      environmentFingerprint: 'tui-portable',
    });
    const names = result.tools.map((tool) => tool.name);
    expect(names).not.toContain('exec');
    expect(names).not.toContain('job_start');
    expect(names).toContain('git_status');
    expect(names).toContain('code_symbols');
    expect(names).toContain('code_definition');
    expect(names).toContain('action_app_game_check');
    expect(result.prompt).toContain('Portable Git');
    expect(result.prompt).toContain('action_app_game_check');
    expect(result.prompt).toContain('Code intelligence provider: text');
    expect(result.prompt).not.toContain('/Users/');
  });

  it('requires Legacy to be explicit and keeps VirtualShell available there', async () => {
    const result = await createWorkspaceCapabilityComposition({
      workspace: workspace(),
      profile: 'legacy',
    });
    const names = result.tools.map((tool) => tool.name);
    expect(names).toContain('exec');
    expect(names).toContain('job_start');
    expect(names).toContain('git_status');
    expect(result.prompt).toContain('Legacy VirtualShell');
  });

  it('evaluates verification in event order', () => {
    expect(
      evaluateCompletion(
        { rows: rows([
          ['write_file', 'completed'],
          ['action_app_game_check', 'completed'],
        ]) },
        'portable',
        true
      )
    ).toEqual({ ok: true });
    expect(
      evaluateCompletion(
        { rows: rows([
          ['action_app_game_check', 'completed'],
          ['write_file', 'completed'],
        ]) },
        'portable',
        true
      )
    ).toMatchObject({ ok: false });
    expect(
      evaluateCompletion(
        { rows: rows([
          ['write_file', 'completed'],
          ['action_app_game_check', 'failed'],
        ]) },
        'portable',
        true
      )
    ).toMatchObject({ ok: false });
    expect(
      evaluateCompletion(
        { rows: rows([['write_file', 'completed']]) },
        'portable',
        false
      )
    ).toMatchObject({ ok: false });
    expect(
      evaluateCompletion(
        { rows: rows([
          ['write_file', 'completed'],
          ['exec', 'completed'],
        ]) },
        'legacy',
        false
      )
    ).toEqual({ ok: true });
  });

  it('produces the same normalized tools for TUI and Headless inputs', async () => {
    const first = await createWorkspaceCapabilityComposition({
      workspace: workspace(),
      profile: 'portable',
      actionRegistry: actionRegistry(),
    });
    const second = await createWorkspaceCapabilityComposition({
      workspace: workspace(),
      profile: 'portable',
      actionRegistry: actionRegistry(),
    });
    expect(
      first.tools.map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
        effect: tool.effect,
      }))
    ).toEqual(
      second.tools.map((tool) => ({
        name: tool.name,
        parameters: tool.parameters,
        effect: tool.effect,
      }))
    );
  });

  it('provides a CompletionGuard wrapper', () => {
    const guard = createWorkspaceCompletionGuard('portable', []);
    expect(
      guard({
        sessionId: 's',
        taskId: 't',
        view: {
          rows: rows([['write_file', 'completed']]),
        } as never,
      })
    ).toMatchObject({ ok: false });
  });
});

function rows(
  entries: Array<[string, 'completed' | 'failed' | 'denied' | 'streaming']>
): Array<{
  id: string;
  entityId: string;
  productTurnId: string;
  kind: 'tool';
  text: string;
  status: 'completed' | 'failed' | 'denied' | 'streaming';
  toolName: string;
}> {
  return entries.map(([toolName, status], index) => ({
    id: `row_${index}`,
    entityId: `tool_${index}`,
    productTurnId: 'task',
    kind: 'tool',
    text: '',
    status,
    toolName,
  }));
}
