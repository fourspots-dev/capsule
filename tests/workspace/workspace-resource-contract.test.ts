import { describe, expect, it } from 'vitest';
import {
  workspaceMimeType,
  workspacePath,
  workspaceResourceRef,
  workspaceResourceUri,
} from '../../src/platform/workspace-resource';
import { createVirtualWorkspaceTools } from '../../src/adapters/virtual-workspace-tools';
import { ToolExecutor } from '../../src/core';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';
import { FakeApproval } from '../harness/fakes';

describe('REQ-WORKSPACE-003 workspace path contract', () => {
  it('normalizes workspace-relative POSIX paths', () => {
    expect(workspacePath('apps/minesweeper/index.html')).toBe(
      'apps/minesweeper/index.html'
    );
    expect(workspacePath('游戏/扫雷.html')).toBe('游戏/扫雷.html');
    expect(workspacePath('folder/file.txt/')).toBe('folder/file.txt');
    expect(workspacePath('', { allowRoot: true })).toBe('');
  });

  it.each([
    ['/etc/passwd', 'WORKSPACE_PATH_INVALID'],
    ['C:\\temp\\file.txt', 'WORKSPACE_PATH_INVALID'],
    ['file:///tmp/app.html', 'WORKSPACE_PATH_NOT_HOST_PATH'],
    ['data:text/html,hello', 'WORKSPACE_PATH_NOT_HOST_PATH'],
    ['~/Desktop/app.html', 'WORKSPACE_PATH_NOT_HOST_PATH'],
    ['src/../../secret', 'WORKSPACE_PATH_ESCAPE'],
    ['src/%2e%2e/secret', 'WORKSPACE_PATH_ESCAPE'],
    ['src//file.ts', 'WORKSPACE_PATH_INVALID'],
    ['CON', 'WORKSPACE_PATH_INVALID'],
  ])('rejects non-workspace path %s', (value, code) => {
    expect(() => workspacePath(value)).toThrowError(
      expect.objectContaining({ code })
    );
  });

  it('creates stable resource references and opaque URIs', () => {
    const ref = workspaceResourceRef({
      workspaceId: 'ws_game',
      path: 'minesweeper.html',
      generation: 7,
    });
    expect(ref).toEqual({
      workspaceId: 'ws_game',
      path: 'minesweeper.html',
      generation: 7,
    });
    expect(workspaceResourceUri('ws_game', ref.path)).toBe(
      'workspace://ws_game/minesweeper.html'
    );
    expect(workspaceMimeType('minesweeper.html')).toContain('text/html');
  });

  it('rejects host paths at the agent tool boundary', async () => {
    const workspace = new VirtualWorkspace({ host: new MemoryHostBridge() });
    const executor = new ToolExecutor(
      createVirtualWorkspaceTools(workspace),
      new FakeApproval(true)
    );
    const result = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: {
        id: 'call_absolute',
        name: 'write_file',
        arguments: '{"path":"/tmp/app.html","text":"bad"}',
      },
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: {
        code: 'WORKSPACE_PATH_INVALID',
      },
    });
  });
});
