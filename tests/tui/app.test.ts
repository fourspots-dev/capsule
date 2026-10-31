import { describe, expect, it } from 'vitest';
import { events, text } from '../harness/fakes';
import { createTestWorkspace } from '../harness/workspace';
import {
  displayWidth,
  LocalTuiRuntimePort,
  TuiApp,
  type TuiAppOptions,
  ViewStateStore,
  type ViewStateStorage,
} from '../../src/tui';

class Storage implements ViewStateStorage {
  values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

async function appWithAnswer(
  answer = 'implemented',
  extra: Partial<TuiAppOptions> = {}
) {
  const harness = createTestWorkspace({
    model: async () => events(...text(answer)),
    tools: [],
  });
  const app = new TuiApp({
    runtime: new LocalTuiRuntimePort(harness.runtime, {
      project: 'tinyai',
      branch: 'main',
    }),
    viewState: new ViewStateStore(new Storage(), 'tui:test'),
    model: 'test-model',
    provider: 'memory',
    now: () => 1_700_000_000_000,
    ...extra,
  });
  await app.initialize();
  return { ...harness, app };
}

describe('TuiApp and renderer', () => {
  it('completes a basic send flow within a compact 80x24 screen', async () => {
    const { app, runtime } = await appWithAnswer('basic answer');
    await app.handleInput('hello world');
    await app.handleInput('\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);

    const lines = app.render(80, 24);
    expect(lines).toHaveLength(24);
    expect(lines.every((line) => displayWidth(line) <= 80)).toBe(true);
    expect(lines[0]).toContain('hello world');
    expect(lines.join('\n')).toContain('hello world');
    expect(lines.join('\n')).toContain('basic answer');
    await app.dispose();
  });

  it('opens compact overlays and creates a local draft without polluting history', async () => {
    const { app, runtime } = await appWithAnswer();
    await app.handleInput('first task');
    await app.handleInput('\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);

    await app.handleInput('\x0b');
    expect(app.routes.current.kind).toBe('sessions');
    expect(app.render(80, 24).join('\n')).toContain('Sessions');
    await app.handleInput('n');
    expect(app.routes.current.kind).toBe('conversation');
    expect(app.sessionsController.active).toMatch(/^session_/);
    expect(app.render(80, 24).join('\n')).toContain('Type a task');

    await app.handleInput('\x07');
    expect(app.routes.current.kind).toBe('agents');
    expect(app.render(80, 24).join('\n')).toContain('No child agents');
    await app.handleInput('\x1b');
    expect(app.routes.current.kind).toBe('conversation');
    await app.dispose();
  });

  it('requires two idle Ctrl+C presses before exiting', async () => {
    const { app } = await appWithAnswer();
    await app.handleInput('\x03');
    expect(app.exitRequested).toBe(false);
    expect(app.render(80, 24).join('\n')).toContain('again to exit');
    await app.handleInput('\x03');
    expect(app.exitRequested).toBe(true);
    await app.dispose();
  });

  it('opens workspace diff evidence in a temporary review view', async () => {
    const { app, runtime } = await appWithAnswer('done', {
      review: async () => ({
        from: 'snapshot_1',
        to: 'snapshot_2',
        files: [
          {
            path: 'src/demo.ts',
            status: 'modified',
            patch: '@@ -1 +1 @@\n-old\n+new\n',
          },
        ],
        additions: 1,
        deletions: 1,
        verification: [{ name: 'typecheck', status: 'passed' }],
      }),
    });
    await app.handleInput('review task\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);
    await app.handleInput('\x0f');
    const screen = app.render(100, 24).join('\n');
    expect(app.routes.current.kind).toBe('review');
    expect(screen).toContain('src/demo.ts');
    expect(screen).toContain('typecheck');
    expect(screen).toContain('+1/-1');
    await app.handleInput('\x1b');
    expect(app.routes.current.kind).toBe('conversation');
    await app.dispose();
  });

  it('shows a generic child agent and navigates into its live session', async () => {
    const { app, runtime } = await appWithAnswer('parent done');
    await app.handleInput('coordinate work\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);
    const parentSession = app.sessionsController.active!;
    const parentTask = runtime
      .getProjection(parentSession)
      .rows.find((row) => row.kind === 'user')!.productTurnId;
    await runtime.ensureSessionReady('child_session_live');
    expect(
      runtime.updateChildTask(parentTask, {
        taskId: 'child_task_live',
        sessionId: 'child_session_live',
        parentTaskId: parentTask,
        parentSessionId: parentSession,
        profileName: 'schema-migrator',
        status: 'running',
        executionMode: 'background',
        summary: 'mapping call sites',
        updatedAt: 10,
      })
    ).toBe(true);

    await app.handleInput('\x07');
    const board = app.render(100, 24).join('\n');
    expect(board).toContain('schema-migrator');
    await app.handleInput('\r');
    expect(app.sessionsController.active).toBe('child_session_live');
    expect(app.routes.current.kind).toBe('conversation');
    await app.handleInput('\x1b');
    expect(app.sessionsController.active).toBe(parentSession);
    expect(app.routes.current.kind).toBe('agents');
    await app.dispose();
  });
});
