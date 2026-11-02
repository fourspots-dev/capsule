import { describe, expect, it } from 'vitest';
import type { WorkspaceApplicationObservation } from '../../src/platform/workspace-interaction';
import { currentWorkspaceObservation } from '../../src/runtime/chrome-scoped-workspace-manager';

describe('REQ-VERIFY-002 workspace application evidence', () => {
  const base: WorkspaceApplicationObservation = {
    id: 'observation_1',
    sessionId: 'session_1',
    taskId: 'task_1',
    workspaceId: 'ws_1',
    path: 'minesweeper.html',
    workspaceGeneration: 10,
    loaded: true,
    consoleErrors: [],
    assertions: [
      { name: 'board', passed: true },
      { name: 'timer', passed: true },
    ],
    createdAt: 200,
  };

  it('accepts current loaded assertions from the active generation', () => {
    expect(currentWorkspaceObservation([base], 10, 100)).toEqual(base);
  });

  it('rejects stale, failed, empty-assertion and console-error evidence', () => {
    expect(currentWorkspaceObservation([base], 11, 100)).toBeUndefined();
    expect(
      currentWorkspaceObservation([{ ...base, createdAt: 50 }], 10, 100)
    ).toBeUndefined();
    expect(
      currentWorkspaceObservation(
        [
          {
            ...base,
            assertions: [{ name: 'board', passed: false }],
          },
        ],
        10,
        100
      )
    ).toBeUndefined();
    expect(
      currentWorkspaceObservation(
        [{ ...base, assertions: [] }],
        10,
        100
      )
    ).toBeUndefined();
    expect(
      currentWorkspaceObservation(
        [{ ...base, consoleErrors: ['boom'] }],
        10,
        100
      )
    ).toBeUndefined();
  });
});
