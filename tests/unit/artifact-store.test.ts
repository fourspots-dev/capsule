import { describe, expect, it } from 'vitest';
import {
  InMemoryArtifactStore,
  textArtifact,
} from '../../src/core/artifact-store';
import { ToolExecutor } from '../../src/core/tool-executor';
import { FakeApproval, readTool } from '../harness/fakes';

describe('InMemoryArtifactStore', () => {
  it('stores defensive binary data and returns stable model-safe refs', async () => {
    let now = 10;
    const store = new InMemoryArtifactStore(() => now);
    const bytes = new TextEncoder().encode('hello');
    const ref = await store.put({
      name: 'output.txt',
      mimeType: 'text/plain',
      kind: 'text',
      data: bytes,
      sessionId: 'session_1',
      taskId: 'task_1',
    });
    bytes[0] = 0;
    expect(ref).toEqual({
      artifactId: 'artifact_1',
      name: 'output.txt',
      mimeType: 'text/plain',
      bytes: 5,
      kind: 'text',
    });
    expect(new TextDecoder().decode(await store.read(ref.artifactId))).toBe('hello');
    now += 1;
    await textArtifact(store, {
      name: 'second.log',
      text: 'log',
      kind: 'log',
      sessionId: 'session_1',
      taskId: 'task_2',
    });
    expect((await store.list({ sessionId: 'session_1' })).map((item) => item.id)).toEqual([
      'artifact_1',
      'artifact_2',
    ]);
  });

  it('removes and cleans artifacts by lifecycle age', async () => {
    let now = 10;
    const store = new InMemoryArtifactStore(() => now);
    const first = await textArtifact(store, { name: 'a', text: 'a' });
    now = 20;
    const second = await textArtifact(store, { name: 'b', text: 'b' });
    expect(await store.remove(first.artifactId)).toBe(true);
    expect(await store.read(first.artifactId)).toBeUndefined();
    expect(await store.cleanup(21)).toBe(1);
    expect(await store.metadata(second.artifactId)).toBeUndefined();
  });

  it('keeps large tool output out of the model context', async () => {
    const store = new InMemoryArtifactStore();
    const executor = new ToolExecutor(
      [readTool('read', async () => 'x'.repeat(100))],
      new FakeApproval(true),
      { artifacts: { store, thresholdBytes: 20 } }
    );
    const result = await executor.execute({
      sessionId: 'session_1',
      taskId: 'task_1',
      signal: new AbortController().signal,
      call: { id: 'call_1', name: 'read', arguments: '{}' },
    });
    expect(result.output).toMatchObject({
      artifact: {
        artifactId: 'artifact_1',
        bytes: 100,
      },
      truncated: true,
    });
    expect((await store.list({ sessionId: 'session_1' }))[0]).toMatchObject({
      name: 'read-call_1.txt',
      bytes: 100,
    });
  });
});
