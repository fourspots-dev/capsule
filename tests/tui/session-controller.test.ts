import { describe, expect, it } from 'vitest';
import type {
  CommandAck,
  CommandEnvelope,
  ProductProjection,
} from '../../src/core';
import {
  SessionController,
  ViewStateStore,
  type ProjectionEnvelope,
  type RuntimeSessionSummary,
  type TuiRuntimePort,
} from '../../src/tui';

class FakeRuntime implements TuiRuntimePort {
  readonly commands: CommandEnvelope[] = [];
  readonly stops: string[] = [];
  private readonly subscriptions = new Map<
    string,
    { sessionId: string; listener: (envelope: ProjectionEnvelope) => void }
  >();

  async listSessions(): Promise<RuntimeSessionSummary[]> {
    return [];
  }

  async loadProjection(sessionId: string): Promise<ProductProjection> {
    return projection(sessionId, 1);
  }

  async subscribe(
    sessionId: string,
    subscriptionId: string,
    listener: (envelope: ProjectionEnvelope) => void
  ): Promise<() => void> {
    this.subscriptions.set(subscriptionId, { sessionId, listener });
    return () => {
      this.subscriptions.delete(subscriptionId);
    };
  }

  async command(command: CommandEnvelope): Promise<CommandAck> {
    this.commands.push(command);
    return {
      commandId: command.commandId,
      sessionId: command.sessionId,
      status: 'accepted',
      revision: 1,
    };
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stops.push(sessionId);
  }

  async deleteSession(): Promise<void> {}
  async renameSession(): Promise<void> {}

  emit(sessionId: string, subscriptionId: string, value: ProductProjection): void {
    this.subscriptions.get(subscriptionId)?.listener({
      sessionId,
      logEpoch: value.logEpoch,
      subscriptionId,
      frame: { type: 'snapshot', projection: value },
    });
  }
}

describe('TUI SessionController', () => {
  it('switches without stopping background sessions and rejects stale frames', async () => {
    const runtime = new FakeRuntime();
    const views = new ViewStateStore();
    const controller = new SessionController(runtime, views, () => 10);

    await controller.switch('A');
    await views.update('A', { draftText: 'draft A', cursor: 7 });
    await controller.switch('B');
    await views.update('B', { draftText: 'draft B', cursor: 7 });
    await controller.switch('C');

    expect(controller.active).toBe('C');
    expect(controller.currentProjection?.sessionId).toBe('C');
    expect((await views.get('A')).draftText).toBe('draft A');
    expect((await views.get('B')).draftText).toBe('draft B');
    expect(runtime.stops).toEqual([]);

    runtime.emit('A', 'tui_subscription_1', projection('A', 3));
    expect(controller.currentProjection?.sessionId).toBe('C');
    expect(
      controller.receive({
        sessionId: 'C',
        logEpoch: 'epoch_C',
        subscriptionId: 'stale-subscription',
        frame: { type: 'snapshot', projection: projection('C', 9) },
      })
    ).toBe(false);
    expect(controller.currentProjection?.revision).toBe(1);

    await controller.send('continue C');
    expect(runtime.commands.at(-1)).toMatchObject({
      sessionId: 'C',
      type: 'send_input',
      payload: { text: 'continue C' },
    });
    await controller.dispose();
  });

  it('accepts a delta only for the active subscription and epoch', async () => {
    const runtime = new FakeRuntime();
    const controller = new SessionController(runtime, new ViewStateStore());
    await controller.switch('A');
    expect(
      controller.receive({
        sessionId: 'A',
        logEpoch: 'epoch_A',
        subscriptionId: 'tui_subscription_1',
        frame: {
          type: 'delta',
          sessionId: 'A',
          logEpoch: 'epoch_A',
          baseRevision: 1,
          revision: 2,
          eventSeq: 2,
          deltas: [
            {
              type: 'state.updated',
              patch: { taskStatus: 'running', phase: 'running' },
            },
          ],
        },
      })
    ).toBe(true);
    expect(controller.currentProjection).toMatchObject({
      sessionId: 'A',
      revision: 2,
      taskStatus: 'running',
    });
  });
});

function projection(sessionId: string, revision: number): ProductProjection {
  return {
    sessionId,
    revision,
    eventSeq: revision,
    logEpoch: `epoch_${sessionId}`,
    phase: revision === 1 ? 'draft' : 'running',
    lifecycle: 'ready',
    taskStatus: revision === 1 ? 'completed' : 'running',
    inputRouting: 'startNow',
    queueLength: 0,
    permissionMode: 'guarded',
    rows: [],
    availability: {
      canSend: true,
      canStop: false,
      canApprove: false,
      canQueue: false,
    },
  };
}
