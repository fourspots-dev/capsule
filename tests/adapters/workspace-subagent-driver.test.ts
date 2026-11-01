import { describe, expect, it } from 'vitest';
import { WorkspaceSubagentDriver } from '../../src/runtime/workspace-subagent-driver';
import {
  AgentProfileRegistry,
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
  type WorkspaceRuntimeOptions,
} from '../../src/core';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';
import { events, text, toolCall } from '../harness/fakes';
import { FakeApproval } from '../harness/fakes';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('WorkspaceSubagentDriver virtual forks', () => {
  it('creates an isolated child workspace and merges only after preview', async () => {
    const parent = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'subagent:parent',
    });
    await parent.fs.write('src/value.ts', encoder.encode('export const value = 1;\n'));
    let childWorkspace: VirtualWorkspace | undefined;
    const ids = new SequentialIdGenerator();
    const driver = new WorkspaceSubagentDriver({
      ids,
      async forkWorkspace() {
        childWorkspace = await parent.fork();
        return childWorkspace;
      },
      createRuntime({ sessionId, workspace }) {
        if (!workspace) throw new Error('child workspace missing');
        return new WorkspaceRuntime({
          model: { async *stream() { yield* events(...text('child done')); } },
          tools: new ToolExecutor([], new FakeApproval(true)),
          clock: { now: () => 1, setTimeout: () => 1, clearTimeout: () => undefined },
          ids,
          systemPrompt: 'child',
        });
      },
    });
    const registry = new AgentProfileRegistry();
    registry.register({
      name: 'worker',
      displayName: 'worker',
      description: 'worker',
      instructions: 'work',
      source: 'builtin',
      skills: [],
      tools: {},
      mcpServers: [],
      permissions: { capabilities: [], effects: ['write'] },
      contextMode: 'fresh',
      execution: {
        defaultMode: 'background',
        allowedModes: ['background'],
      },
      maxDepth: 2,
      maxConcurrency: 2,
    });
    const created = await driver.create({
      taskId: 'child_1',
      spec: {
        parentTaskId: 'parent_task',
        parentSessionId: 'parent_session',
        profile: 'worker',
        brief: 'change the value',
        budget: {},
        contextMode: 'fresh',
        executionMode: 'background',
      },
      profile: registry.resolve('worker', { capabilities: [], effects: ['write'] }),
      prompt: 'change the value',
    });
    expect(created.sessionId).toContain('child_session');
    await childWorkspace!.fs.write(
      'src/value.ts',
      encoder.encode('export const value = 2;\n')
    );
    expect(decoder.decode(await parent.fs.read('src/value.ts'))).toContain('= 1');
    expect(await driver.previewMerge('child_1')).toMatchObject({
      taskId: 'child_1',
      changes: [
        expect.objectContaining({
          path: 'src/value.ts',
          status: 'modified',
        }),
      ],
      conflicts: [],
    });
    await driver.applyMerge('child_1');
    expect(decoder.decode(await parent.fs.read('src/value.ts'))).toContain('= 2');
    await driver.dispose();
  });

  it('returns child artifact and evidence identity without sharing parent results', async () => {
    const parent = new VirtualWorkspace({
      host: new MemoryHostBridge(),
      storageKey: 'subagent:evidence-parent',
    });
    const ids = new SequentialIdGenerator();
    const profiles = new AgentProfileRegistry();
    profiles.register({
      name: 'worker',
      displayName: 'worker',
      description: 'worker',
      instructions: '',
      source: 'builtin',
      skills: [],
      tools: {},
      mcpServers: [],
      permissions: { capabilities: [], effects: ['read'] },
      contextMode: 'fresh',
      execution: {
        defaultMode: 'background',
        allowedModes: ['background'],
      },
      maxDepth: 2,
      maxConcurrency: 1,
    });
    const driver = new WorkspaceSubagentDriver({
      ids,
      forkWorkspace: () => parent.fork(),
      createRuntime({ workspace }) {
        if (!workspace) throw new Error('child workspace missing');
        let calls = 0;
        const tools = new ToolExecutor(
          [
            {
              name: 'child_check',
              description: 'Child check',
              parameters: { type: 'object', properties: {} },
              risk: 'read',
              execute: async () => ({ passed: true }),
              executeDetailed: async () => ({
                value: { passed: true },
                metadata: {
                  artifactIds: ['artifact_child'],
                  evidence: {
                    id: 'evidence_child',
                    status: 'current',
                  },
                },
              }),
            },
          ],
          new FakeApproval(true)
        );
        return new WorkspaceRuntime({
          model: {
            async *stream() {
              calls += 1;
              yield* events(
                ...(calls === 1
                  ? toolCall('call_child', 'child_check', {})
                  : text('child done'))
              );
            },
          },
          tools,
          clock: { now: () => 1, setTimeout: () => 1, clearTimeout: () => undefined },
          ids,
        });
      },
    });
    await driver.create({
      taskId: 'child_evidence',
      spec: {
        parentTaskId: 'parent_task',
        profile: 'worker',
        brief: 'check',
        budget: {},
        contextMode: 'fresh',
        executionMode: 'background',
      },
      profile: profiles.resolve('worker', {
        capabilities: [],
        effects: ['read'],
      }),
      prompt: 'check',
    });
    const result = await driver.run(
      'child_evidence',
      new AbortController().signal
    );
    expect(result).toMatchObject({
      status: 'completed',
      artifacts: ['artifact_child'],
      output: {
        evidence: [{ id: 'evidence_child', status: 'current' }],
      },
    });
  });
});
