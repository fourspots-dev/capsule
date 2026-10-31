import { describe, expect, it } from 'vitest';
import type { ProductProjection } from '../../src/core';
import type {
  RuntimePort,
  RuntimeRequest,
  RuntimeResponse,
} from '../../src/runtime/protocol';
import { KernelClient } from '../../src/sidepanel/kernel-client';
import { until } from '../harness/fakes';
import { command } from '../harness/workspace';

class ClientPort implements RuntimePort {
  readonly outbound: RuntimeRequest[] = [];
  private listeners: Array<(message: RuntimeRequest | RuntimeResponse) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  readonly onMessage = {
    addListener: (listener: (message: RuntimeRequest | RuntimeResponse) => void) => {
      this.listeners.push(listener);
    },
    removeListener: (listener: (message: RuntimeRequest | RuntimeResponse) => void) => {
      this.listeners = this.listeners.filter((item) => item !== listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void) => {
      this.disconnectListeners.push(listener);
    },
    removeListener: (listener: () => void) => {
      this.disconnectListeners = this.disconnectListeners.filter((item) => item !== listener);
    },
  };

  postMessage(message: RuntimeRequest | RuntimeResponse): void {
    if (isRequest(message)) this.outbound.push(message);
  }

  receive(message: RuntimeResponse): void {
    for (const listener of this.listeners) listener(message);
  }
}

function isRequest(message: RuntimeRequest | RuntimeResponse): message is RuntimeRequest {
  return ['hello', 'subscribe', 'unsubscribe', 'command', 'get_projection', 'query_command', 'stop_session', 'approval_response'].includes(message.type);
}

function projection(revision: number): ProductProjection {
  return {
    sessionId: 'session_1',
    revision,
    eventSeq: revision,
    logEpoch: 'epoch_1',
    phase: revision === 1 ? 'running' : 'completed',
    lifecycle: 'ready',
    taskStatus: revision === 1 ? 'running' : 'completed',
    inputRouting: revision === 1 ? 'queue' : 'startNow',
    queueLength: 0,
    permissionMode: 'guarded',
    rows:
      revision === 1
        ? []
        : [
            {
              id: 'row_1',
              entityId: 'entity_1',
              productTurnId: 'task_1',
              kind: 'assistant',
              text: 'done',
              status: 'completed',
            },
          ],
    availability: {
      canSend: true,
      canStop: revision === 1,
      canApprove: false,
      canQueue: revision === 1,
    },
  };
}

describe('KernelClient', () => {
  it('correlates requests, applies projection frames and surfaces approvals', async () => {
    const port = new ClientPort();
    const client = new KernelClient(() => port, { requestTimeoutMs: 1_000 });
    const commandPromise = client.command(command('session_1', 'command_1', 'hello'));
    await until(() => port.outbound.length === 1);
    const request = port.outbound[0];
    expect(request).toMatchObject({ type: 'command', command: { commandId: 'command_1' } });
    if (!request.requestId) throw new Error('request id missing');
    port.receive({
      type: 'response',
      requestId: request.requestId,
      ok: true,
      data: {
        commandId: 'command_1',
        sessionId: 'session_1',
        status: 'accepted',
        revision: 1,
      },
    });
    await expect(commandPromise).resolves.toMatchObject({ status: 'accepted' });

    const projections: ProductProjection[] = [];
    client.onProjection((_sessionId, value) => projections.push(value));
    const subscribe = client.subscribe('session_1');
    await until(() => port.outbound.length === 2);
    const subscribeRequest = port.outbound[1];
    if (subscribeRequest.type !== 'subscribe') throw new Error('subscribe request missing');
    port.receive({
      type: 'projection',
      sessionId: 'session_1',
      logEpoch: 'epoch_1',
      subscriptionId: subscribeRequest.subscriptionId,
      frame: { type: 'snapshot', projection: projection(1) },
    });
    port.receive({
      type: 'response',
      requestId: subscribeRequest.requestId!,
      ok: true,
      data: true,
    });
    await subscribe;
    port.receive({
      type: 'projection',
      sessionId: 'session_1',
      logEpoch: 'epoch_1',
      subscriptionId: subscribeRequest.subscriptionId,
      frame: {
        type: 'delta',
        sessionId: 'session_1',
        logEpoch: 'epoch_1',
        baseRevision: 1,
        revision: 2,
        eventSeq: 2,
        deltas: [
          {
            type: 'state.updated',
            patch: {
              phase: 'completed',
              taskStatus: 'completed',
              inputRouting: 'startNow',
              availability: {
                canSend: true,
                canStop: false,
                canApprove: false,
                canQueue: false,
              },
            },
          },
          {
            type: 'row.appended',
            row: {
              id: 'row_1',
              entityId: 'entity_1',
              productTurnId: 'task_1',
              kind: 'assistant',
              text: 'done',
              status: 'completed',
            },
          },
        ],
      },
    });
    expect(projections.at(-1)).toEqual(projection(2));

    port.receive({
      type: 'projection',
      sessionId: 'session_1',
      logEpoch: 'epoch_1',
      subscriptionId: 'stale_subscription',
      frame: { type: 'snapshot', projection: projection(99) },
    });
    expect(projections.at(-1)).toEqual(projection(2));

    const approvals: string[] = [];
    client.onApproval((event) => approvals.push(event.approvalId));
    port.receive({
      type: 'approval_request',
      approvalId: 'approval_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      callId: 'call_1',
      toolName: 'click',
      risk: 'write',
      input: {},
    });
    expect(approvals).toEqual(['approval_1']);
    const handoffs: string[] = [];
    client.onHandoff((event) => handoffs.push(event.handoffId));
    port.receive({
      type: 'handoff_request',
      handoffId: 'handoff_1',
      sessionId: 'session_1',
      taskId: 'task_1',
      toolName: 'await_user_action',
      reason: 'login',
    });
    expect(handoffs).toEqual(['handoff_1']);
    client.disconnect();
  });
});
