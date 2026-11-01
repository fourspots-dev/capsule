import { describe, expect, it, vi } from 'vitest';
import { InMemoryArtifactStore } from '../../src/core/artifact-store';
import { ToolExecutor } from '../../src/core/tool-executor';
import type { ToolDefinition } from '../../src/core/types';
import {
  HostApprovalReceiptStore,
  InMemoryApprovalReceiptStore,
} from '../../src/adapters/host-approval-receipt-store';
import { MemoryHostBridge } from '../../src/host';
import { FakeApproval } from '../harness/fakes';

describe('REQ-ACTION-002 tool execution integrity', () => {
  it('carries Action metadata and binary attachments into ToolExecutionResult', async () => {
    const artifacts = new InMemoryArtifactStore();
    const binary = new Uint8Array([0, 1, 255, 4]);
    const tool: ToolDefinition = {
      name: 'action_binary',
      description: 'Binary action',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      execute: async () => ({ ok: true }),
      executeDetailed: async () => ({
        value: { ok: true },
        metadata: {
          status: 'succeeded',
          action: { id: 'app.binary', version: '1.0.0', sourceId: 'test' },
          durationMs: 12,
          exitCode: 0,
          truncated: false,
          artifactIds: ['provider-artifact'],
        },
        attachments: [
          {
            name: 'result.bin',
            mimeType: 'application/octet-stream',
            kind: 'binary',
            data: binary,
          },
        ],
      }),
    };
    const executor = new ToolExecutor([tool], new FakeApproval(true), {
      artifacts: { store: artifacts, thresholdBytes: 100_000 },
    });
    const result = await executor.execute({
      sessionId: 'session',
      taskId: 'task',
      call: { id: 'call', name: 'action_binary', arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'succeeded',
      metadata: {
        action: { id: 'app.binary', version: '1.0.0', sourceId: 'test' },
        durationMs: 12,
        exitCode: 0,
        artifactIds: ['provider-artifact', expect.any(String)],
        artifacts: [
          expect.objectContaining({
            name: 'result.bin',
            kind: 'binary',
            bytes: 4,
          }),
        ],
      },
    });
    const stored = await artifacts.read(
      result.metadata!.artifacts![0].artifactId
    );
    expect(stored).toEqual(binary);
  });

  it('records approved, denied and failed approval decisions', async () => {
    const store = new InMemoryApprovalReceiptStore();
    const execute = vi.fn(async () => ({ ok: true }));
    const tool: ToolDefinition = {
      name: 'action_guarded',
      description: 'Guarded action',
      parameters: { type: 'object', properties: {} },
      risk: 'dangerous',
      execute,
    };
    const approved = new ToolExecutor([tool], new FakeApproval(true), {
      approvalReceipts: store,
    });
    await approved.execute({
      sessionId: 's',
      taskId: 't',
      call: { id: 'call_approved', name: tool.name, arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect((await store.list())[0]).toMatchObject({
      callId: 'call_approved',
      decision: 'approved',
      toolName: 'action_guarded',
    });

    const denied = new ToolExecutor([tool], new FakeApproval(false), {
      approvalReceipts: store,
    });
    await denied.execute({
      sessionId: 's',
      taskId: 't',
      call: { id: 'call_denied', name: tool.name, arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect((await store.list()).at(-1)).toMatchObject({
      callId: 'call_denied',
      decision: 'denied',
    });

    const failingStore = {
      record: async () => {
        throw new Error('disk full');
      },
      list: async () => [],
    };
    const failing = new ToolExecutor([tool], new FakeApproval(true), {
      approvalReceipts: failingStore,
    });
    const result = await failing.execute({
      sessionId: 's',
      taskId: 't',
      call: { id: 'call_failed', name: tool.name, arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'failed',
      error: { code: 'APPROVAL_RECEIPT_FAILED' },
    });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('keeps legacy tools and their text result unchanged', async () => {
    const executor = new ToolExecutor(
      [
        {
          name: 'legacy',
          description: 'Legacy',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          execute: async () => 'legacy output',
        },
      ],
      new FakeApproval(true)
    );
    await expect(
      executor.execute({
        sessionId: 's',
        taskId: 't',
        call: { id: 'legacy', name: 'legacy', arguments: '{}' },
        signal: new AbortController().signal,
      })
    ).resolves.toEqual({
      callId: 'legacy',
      name: 'legacy',
      status: 'succeeded',
      output: 'legacy output',
    });
  });

  it('preserves failure metadata and failure artifacts', async () => {
    const artifacts = new InMemoryArtifactStore();
    const executor = new ToolExecutor(
      [
        {
          name: 'action_failure',
          description: 'Failing action',
          parameters: { type: 'object', properties: {} },
          risk: 'read',
          execute: async () => null,
          executeDetailed: async () => ({
            value: { failed: true },
            metadata: {
              status: 'failed',
              action: {
                id: 'app.failure',
                version: '1.0.0',
                sourceId: 'test',
              },
              exitCode: 2,
            },
            attachments: [
              {
                name: 'failure.log',
                mimeType: 'text/plain',
                kind: 'log',
                data: new TextEncoder().encode('failed'),
              },
            ],
          }),
        },
      ],
      new FakeApproval(true),
      { artifacts: { store: artifacts } }
    );
    const result = await executor.execute({
      sessionId: 's',
      taskId: 't',
      call: { id: 'failure', name: 'action_failure', arguments: '{}' },
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({
      status: 'failed',
      metadata: {
        status: 'failed',
        exitCode: 2,
        artifacts: [expect.objectContaining({ name: 'failure.log' })],
      },
    });
    expect(await artifacts.list()).toHaveLength(1);
  });
});

describe('HostApprovalReceiptStore', () => {
  it('filters receipts by session and task', async () => {
    const store = new InMemoryApprovalReceiptStore();
    await store.record({
      id: 'r1',
      sessionId: 's1',
      taskId: 't1',
      callId: 'c1',
      toolName: 'tool',
      risk: 'write',
      decision: 'approved',
      inputDigest: 'digest',
      createdAt: 1,
    });
    await store.record({
      id: 'r2',
      sessionId: 's2',
      taskId: 't2',
      callId: 'c2',
      toolName: 'tool',
      risk: 'write',
      decision: 'denied',
      inputDigest: 'digest',
      createdAt: 2,
    });
    expect(await store.list({ sessionId: 's1' })).toHaveLength(1);
    expect(await store.list({ taskId: 't2' })).toMatchObject([
      { id: 'r2', decision: 'denied' },
    ]);
  });

  it('persists receipts through the host storage port', async () => {
    const host = new MemoryHostBridge();
    const store = new HostApprovalReceiptStore(host.storage);
    await store.record({
      id: 'persisted',
      sessionId: 's',
      taskId: 't',
      callId: 'c',
      toolName: 'action',
      risk: 'dangerous',
      decision: 'approved',
      inputDigest: 'digest',
      actionDigest: 'action-digest',
      approvalContext: { workspaceGeneration: 3 },
      createdAt: 10,
    });
    expect(await store.list({ sessionId: 's' })).toMatchObject([
      {
        id: 'persisted',
        actionDigest: 'action-digest',
        approvalContext: { workspaceGeneration: 3 },
      },
    ]);
  });
});
