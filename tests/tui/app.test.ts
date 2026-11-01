import { describe, expect, it, vi } from 'vitest';
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

  it('edits at the native cursor target instead of only appending', async () => {
    const { app } = await appWithAnswer();
    await app.handleInput('abc');
    await app.handleInput('\x1b[D\x1b[D');
    await app.handleInput('X');
    await app.handleInput('\x1b[3~');

    const frame = app.renderFrame(80, 24, {
      theme: 'dark',
      depth: 'none',
    });
    const composerLine = frame.lines[frame.cursor.row - 1];
    expect(composerLine).toContain('> aXc');
    expect(composerLine).not.toContain('aXc▌');
    expect(frame.cursor).toMatchObject({
      visible: true,
      shape: 'block',
      row: expect.any(Number),
      column: expect.any(Number),
    });
    expect(composerLine[frame.cursor.column - 1]).toBe('c');
    await app.dispose();
  });

  it('shows a blocking Action approval prompt and resolves allow or deny', async () => {
    const { app } = await appWithAnswer();
    const allow = app.requestApproval(
      {
        sessionId: 'session',
        taskId: 'task',
        callId: 'call_allow',
        toolName: 'action_app_python_tests',
        risk: 'dangerous',
        input: {},
      },
      new AbortController().signal
    );
    expect(app.render(100, 24).join('\n')).toContain(
      'Allow action_app_python_tests (dangerous)'
    );
    await app.handleInput('\r');
    await expect(allow).resolves.toBe(true);

    const denyController = new AbortController();
    const deny = app.requestApproval(
      {
        sessionId: 'session',
        taskId: 'task',
        callId: 'call_deny',
        toolName: 'action_dangerous',
        risk: 'dangerous',
        input: {},
      },
      denyController.signal
    );
    await app.handleInput('\x1b');
    await expect(deny).resolves.toBe(false);
    await app.dispose();
  });

  it('hides the composer cursor while an overlay owns focus', async () => {
    const { app } = await appWithAnswer();
    await app.handleInput('\x0b');
    const search = app.renderFrame(80, 24).cursor;
    expect(search.visible).toBe(true);
    expect(search.row).toBe(3);
    await app.handleInput('\x1b');
    await app.handleInput('\x07');
    expect(app.renderFrame(80, 24).cursor.visible).toBe(false);
    await app.handleInput('\x1b');
    expect(app.renderFrame(80, 24).cursor.visible).toBe(true);
    await app.dispose();
  });

  it('opens a compact read-only application Action manager', async () => {
    const { app } = await appWithAnswer('ready', {
      actions: async () => [
        {
          id: 'app.test.check',
          version: '1.2.0',
          title: 'Run checks',
          description: 'Run the application test suite.',
          sourceId: 'local',
          state: 'available',
          effects: ['execute'],
          risk: 'dangerous',
        },
        {
          id: 'browser.remote',
          version: '1.0.0',
          title: 'Remote browser',
          description: 'Remote action.',
          sourceId: 'remote',
          state: 'degraded',
          effects: ['network'],
          risk: 'write',
          limitations: ['reconnect required'],
        },
      ],
    });
    await app.handleInput('\x19');
    const first = app.render(100, 24).join('\n');
    expect(first).toContain('ACTIONS');
    expect(first).toContain('app.test.check');
    expect(first).toContain('Run checks');
    expect(first).toContain('reconnect required');
    await app.handleInput('\x1b[B');
    expect(app.routes.current).toMatchObject({
      kind: 'actions',
      selectedId: 'browser.remote',
    });
    await app.handleInput('\x1b');
    expect(app.routes.current.kind).toBe('conversation');
    await app.dispose();
  });

  it('keeps one visible space between the prompt and the native block cursor', async () => {
    const { app } = await appWithAnswer();
    const frame = app.renderFrame(80, 24, {
      theme: 'dark',
      depth: 'none',
    });
    const composerLine = frame.lines[frame.cursor.row - 1];

    expect(frame.cursor.shape).toBe('block');
    expect(composerLine).toContain('│ > ');
    expect(composerLine[frame.cursor.column - 2]).toBe(' ');
    await app.dispose();
  });

  it('keeps Unicode graphemes intact while editing around the native cursor', async () => {
    const { app } = await appWithAnswer();
    await app.handleInput('a👨‍👩‍👧‍👦b');
    await app.handleInput('\x1b[D\x1b[D');
    await app.handleInput('X');

    const frame = app.renderFrame(100, 24, {
      theme: 'dark',
      depth: 'none',
    });
    const composerLine = frame.lines[frame.cursor.row - 1];
    expect(composerLine).toContain('> aX👨‍👩‍👧‍👦b');
    expect(composerLine).not.toContain('�');
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

  it('removes terminal control sequences from model and tool output', async () => {
    const { app, runtime } = await appWithAnswer('\u001b[2Junsafe\u001b]0;title\u0007');
    await app.handleInput('render safely\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);
    const screen = app.render(80, 24).join('\n');
    expect(screen).not.toContain('\u001b');
    expect(screen).not.toContain('\u0007');
    expect(screen).toContain('unsafe');
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

  it('exports a workspace capsule from the TUI and reports its path', async () => {
    const capsuleExport = vi.fn(async () => ({
      path: '/tmp/tinyai-test.capsule',
    }));
    const { app } = await appWithAnswer('ready', { capsuleExport });
    await app.handleInput('\x18');
    expect(capsuleExport).toHaveBeenCalledTimes(1);
    expect(app.render(100, 24).join('\n')).toContain(
      'Capsule exported: /tmp/tinyai-test.capsule'
    );
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

  it('requires merge preview before applying a child workspace', async () => {
    const previewMerge = vi.fn(async () => ({
      from: 'child-fork',
      to: 'workspace-child',
      files: [
        {
          path: 'src/child.ts',
          status: 'added' as const,
          patch: '@@ -0,0 +1 @@\n+child\n',
        },
      ],
      additions: 1,
      deletions: 0,
    }));
    const applyMerge = vi.fn(async () => undefined);
    const { app, runtime } = await appWithAnswer('parent done', {
      agentWorkspace: { previewMerge, applyMerge },
    });
    await app.handleInput('coordinate merge\r');
    await runtime.waitForSessionIdle(app.sessionsController.active!);
    const parentSession = app.sessionsController.active!;
    const parentTask = runtime
      .getProjection(parentSession)
      .rows.find((row) => row.kind === 'user')!.productTurnId;
    await runtime.ensureSessionReady('child_merge_session');
    runtime.updateChildTask(parentTask, {
      taskId: 'child_merge_task',
      sessionId: 'child_merge_session',
      parentTaskId: parentTask,
      parentSessionId: parentSession,
      profileName: 'merge-worker',
      status: 'completed',
      executionMode: 'background',
    });
    await app.handleInput('\x07a');
    expect(app.render(80, 24).join('\n')).toContain('Preview this merge with M');
    expect(applyMerge).not.toHaveBeenCalled();
    await app.handleInput('m');
    expect(previewMerge).toHaveBeenCalledWith('child_merge_task');
    expect(app.render(100, 24).join('\n')).toContain('src/child.ts');
    await app.handleInput('\x1b');
    await app.handleInput('a\r');
    expect(applyMerge).toHaveBeenCalledWith('child_merge_task');
    await app.dispose();
  });
});
