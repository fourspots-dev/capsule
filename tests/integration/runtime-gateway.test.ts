import { describe, expect, it } from 'vitest';
import {
  InMemorySessionStore,
  InMemoryArtifactStore,
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
} from '../../src/core';
import { PortApprovalBroker } from '../../src/runtime/approval-broker';
import type { RuntimePort, RuntimeRequest, RuntimeResponse } from '../../src/runtime/protocol';
import { RuntimeGateway } from '../../src/runtime/runtime-gateway';
import { FakeApproval, FakeClock, events, text, until } from '../harness/fakes';
import { command } from '../harness/workspace';

class FakePort implements RuntimePort {
  readonly sent: RuntimeResponse[] = [];
  private messageListeners: Array<(message: RuntimeRequest | RuntimeResponse) => void> = [];
  private disconnectListeners: Array<() => void> = [];

  readonly onMessage = {
    addListener: (listener: (message: RuntimeRequest | RuntimeResponse) => void) => {
      this.messageListeners.push(listener);
    },
    removeListener: (listener: (message: RuntimeRequest | RuntimeResponse) => void) => {
      this.messageListeners = this.messageListeners.filter((item) => item !== listener);
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
    if ('type' in message && isRuntimeResponse(message)) this.sent.push(message);
  }

  send(message: RuntimeRequest): void {
    for (const listener of this.messageListeners) listener(message);
  }

  disconnect(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

function isRuntimeResponse(
  message: RuntimeRequest | RuntimeResponse
): message is RuntimeResponse {
  return ['ready', 'response', 'projection', 'approval_request', 'handoff_request'].includes(message.type);
}

function workspace() {
  return new WorkspaceRuntime({
    model: {
      async *stream(_request) {
        yield* events(...text('done'));
      },
    },
    tools: new ToolExecutor([], new FakeApproval(true)),
    clock: new FakeClock(),
    ids: new SequentialIdGenerator(),
    sessionStore: new InMemorySessionStore(),
  });
}

describe('RuntimeGateway', () => {
  it('routes commands and emits snapshot plus closed projection deltas over one port', async () => {
    const runtime = workspace();
    const gateway = new RuntimeGateway(async () => ({
      runtime,
      async dispose() {
        await runtime.dispose();
      },
    }));
    const port = new FakePort();
    gateway.connect(port);

    port.send({ type: 'hello', clientId: 'sidepanel' });
    await until(() => port.sent.some((message) => message.type === 'ready'));

    port.send({
      type: 'command',
      command: command('session_1', 'command_1', 'first'),
    });
    await until(() =>
      port.sent.some(
        (message) =>
          message.type === 'response' &&
          message.requestId === 'command_1' &&
          message.ok
      )
    );
    await runtime.waitForSessionIdle('session_1');

    port.send({ type: 'subscribe', sessionId: 'session_1' });
    await until(() =>
      port.sent.some(
        (message) => message.type === 'projection' && message.frame.type === 'snapshot'
      )
    );

    port.send({
      type: 'command',
      command: command('session_1', 'command_2', 'second'),
    });
    await until(() =>
      port.sent.some(
        (message) => message.type === 'projection' && message.frame.type === 'delta'
      )
    );
    const snapshot = port.sent.find(
      (message) => message.type === 'projection' && message.frame.type === 'snapshot'
    );
    expect(snapshot).toBeDefined();
    expect(
      port.sent.some(
        (message) =>
          message.type === 'projection' &&
          message.frame.type === 'delta' &&
          message.frame.deltas.some((delta) => delta.type === 'row.appended')
      )
    ).toBe(true);

    port.disconnect();
    await gateway.dispose();
  });

  it('returns stable structured errors for unknown sessions', async () => {
    const gateway = new RuntimeGateway(async () => ({
      runtime: workspace(),
      async dispose() {},
    }));
    const port = new FakePort();
    gateway.connect(port);
    port.send({ type: 'get_projection', sessionId: 'missing' });
    await until(() => port.sent.some((message) => message.type === 'response' && !message.ok));
    expect(port.sent.find((message) => message.type === 'response' && !message.ok)).toMatchObject({
      ok: false,
      error: { code: 'SESSION_NOT_FOUND' },
    });
    port.disconnect();
    await gateway.dispose();
  });

  it('lists skills declared by extensions without exposing storage details', async () => {
    const gateway = new RuntimeGateway(async () => ({
      runtime: workspace(),
      skills: async () => [
        { name: 'review', description: 'Review changes', body: 'Check evidence.' },
      ],
      async dispose() {},
    }));
    const port = new FakePort();
    gateway.connect(port);
    port.send({ type: 'list_skills', requestId: 'skills-1' });
    await until(() =>
      port.sent.some(
        (message) =>
          message.type === 'response' &&
          message.requestId === 'skills-1' &&
          message.ok
      )
    );
    expect(
      port.sent.find(
        (message) => message.type === 'response' && message.requestId === 'skills-1'
      )
    ).toMatchObject({
      ok: true,
      data: [{ name: 'review', body: 'Check evidence.' }],
    });
    port.disconnect();
    await gateway.dispose();
  });

  it('returns artifact bytes only by stable artifact id', async () => {
    const artifacts = new InMemoryArtifactStore();
    const ref = await artifacts.put({
      name: 'log.txt',
      mimeType: 'text/plain',
      kind: 'log',
      data: new TextEncoder().encode('artifact evidence'),
    });
    const gateway = new RuntimeGateway(async () => ({
      runtime: workspace(),
      artifacts,
      async dispose() {},
    }));
    const port = new FakePort();
    gateway.connect(port);
    port.send({ type: 'read_artifact', artifactId: ref.artifactId, requestId: 'artifact-1' });
    await until(() =>
      port.sent.some(
        (message) =>
          message.type === 'response' &&
          message.requestId === 'artifact-1' &&
          message.ok
      )
    );
    const response = port.sent.find(
      (message) => message.type === 'response' && message.requestId === 'artifact-1'
    );
    expect(response).toMatchObject({
      ok: true,
      data: {
        metadata: { name: 'log.txt', kind: 'log' },
        dataBase64: expect.any(String),
      },
    });
    port.disconnect();
    await gateway.dispose();
  });
});

describe('PortApprovalBroker', () => {
  it('broadcasts an approval and resolves the waiting tool call by id', async () => {
    const broker = new PortApprovalBroker({ mode: 'ask', timeoutMs: 1_000 });
    const port = new FakePort();
    broker.attach(port);
    const pending = broker.requestApproval(
      {
        sessionId: 'session_1',
        taskId: 'task_1',
        callId: 'call_1',
        toolName: 'click',
        risk: 'write',
        input: { selector: 'button' },
      },
      new AbortController().signal
    );
    await until(() => port.sent.some((message) => message.type === 'approval_request'));
    const request = port.sent.find((message) => message.type === 'approval_request');
    if (!request || request.type !== 'approval_request') throw new Error('approval missing');
    expect(broker.respond(request.approvalId, true)).toBe(true);
    await expect(pending).resolves.toBe(true);
    broker.dispose();
  });

  it('pauses for explicit manual handoff and resolves continue/cancel', async () => {
    const broker = new PortApprovalBroker({ mode: 'auto', timeoutMs: 1_000 });
    const port = new FakePort();
    broker.attach(port);
    const pending = broker.requestHandoff(
      'Complete the login',
      { sessionId: 'session_1', taskId: 'task_1', toolName: 'await_user_action' },
      new AbortController().signal
    );
    await until(() => port.sent.some((message) => message.type === 'handoff_request'));
    const request = port.sent.find((message) => message.type === 'handoff_request');
    if (!request || request.type !== 'handoff_request') throw new Error('handoff missing');
    expect(broker.respondHandoff(request.handoffId, 'continue')).toBe(true);
    await expect(pending).resolves.toBe('continue');
    broker.dispose();
  });
});
