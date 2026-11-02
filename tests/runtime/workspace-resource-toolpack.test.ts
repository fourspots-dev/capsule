import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceInteractionProvider } from '../../src/platform/workspace-interaction';
import { createWorkspaceResourceTools } from '../../src/runtime/workspace-resource-toolpack';
import { ToolExecutor } from '../../src/core';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';
import { FakeApproval } from '../harness/fakes';

describe('REQ-HOST-004 workspace resource ToolPack', () => {
  it('exposes open and export only when host capabilities exist', async () => {
    const workspace = new VirtualWorkspace({ host: new MemoryHostBridge() });
    await workspace.fs.write(
      'minesweeper.html',
      new TextEncoder().encode('<h1>game</h1>')
    );
    const open = vi.fn(async (resource) => ({
      mode: 'embedded-preview' as const,
      resource,
      targetId: '42',
    }));
    const exportFile = vi.fn(async () => ({
      artifactId: 'download-1',
      displayName: 'minesweeper.html',
      bytes: 13,
      destination: 'download' as const,
    }));
    const provider: WorkspaceInteractionProvider = {
      hostId: 'test',
      async capabilities() {
        return {
          open: { available: true, modes: ['embedded-preview'] },
          export: { available: true, destinations: ['download'] },
        };
      },
      open: {
        async capabilities() {
          return { available: true, modes: ['embedded-preview'] };
        },
        open,
      },
      export: {
        async capabilities() {
          return { available: true, destinations: ['download'] };
        },
        export: exportFile,
      },
    };
    const result = await createWorkspaceResourceTools({ workspace, provider });
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'get_workspace_info',
      'open_workspace_file',
      'export_workspace_file',
    ]);
    const executor = new ToolExecutor(result.tools, new FakeApproval(true));
    const invocation = {
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
    };
    await expect(
      executor.execute({
        ...invocation,
        call: {
          id: 'call_open',
          name: 'open_workspace_file',
          arguments: '{"path":"minesweeper.html"}',
        },
      })
    ).resolves.toMatchObject({
      status: 'succeeded',
      output: {
        targetId: '42',
        resourceUri: expect.stringContaining('workspace://'),
      },
    });
    await expect(
      executor.execute({
        ...invocation,
        call: {
          id: 'call_export',
          name: 'export_workspace_file',
          arguments: '{"path":"minesweeper.html"}',
        },
      })
    ).resolves.toMatchObject({
      status: 'succeeded',
      output: {
        artifactId: 'download-1',
        mimeType: expect.stringContaining('text/html'),
      },
    });
  });

  it('omits unsupported operations and keeps workspace info generic', async () => {
    const workspace = new VirtualWorkspace({ host: new MemoryHostBridge() });
    const provider: WorkspaceInteractionProvider = {
      hostId: 'headless',
      async capabilities() {
        return {
          open: { available: false, modes: [] },
          export: { available: false, destinations: [] },
        };
      },
    };
    const result = await createWorkspaceResourceTools({ workspace, provider });
    expect(result.tools.map((tool) => tool.name)).toEqual([
      'get_workspace_info',
    ]);
  });
});
