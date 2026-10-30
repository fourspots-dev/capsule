import { describe, expect, it } from 'vitest';
import { InMemorySandbox } from '../../src/core/in-memory-sandbox';

describe('InMemorySandbox', () => {
  it('isolates workspace paths and enforces leases', async () => {
    const sandbox = new InMemorySandbox({ now: () => 100 });
    const lease = await sandbox.createWorkspace({ sessionId: 's' });
    await sandbox.writeFile(lease, 'src/a.ts', new TextEncoder().encode('hello'));
    expect(new TextDecoder().decode((await sandbox.readFile(lease, 'src/a.ts')).data)).toBe('hello');
    expect(await sandbox.listFiles(lease, 'src')).toHaveLength(1);
    await expect(sandbox.readFile(lease, '../../etc/passwd')).rejects.toMatchObject({
      code: 'SANDBOX_PATH_ESCAPE',
    });
    await sandbox.release(lease);
    await expect(sandbox.readFile(lease, 'src/a.ts')).rejects.toMatchObject({
      code: 'SANDBOX_LEASE_INVALID',
    });
  });

  it('enforces read-only and idempotent effects', async () => {
    const sandbox = new InMemorySandbox({ now: () => 100 });
    const lease = await sandbox.createWorkspace({ sessionId: 's', readOnly: true });
    await expect(
      sandbox.writeFile(lease, 'a', new Uint8Array([1]))
    ).rejects.toMatchObject({ code: 'SANDBOX_READ_ONLY' });
    const writable = await sandbox.createWorkspace({ sessionId: 'w' });
    const first = await sandbox.writeFile(writable, 'a', new Uint8Array([1]), {
      idempotencyKey: 'write-a',
    });
    const second = await sandbox.writeFile(writable, 'a', new Uint8Array([2]), {
      idempotencyKey: 'write-a',
    });
    expect(second).toEqual(first);
    expect(new TextDecoder().decode((await sandbox.readFile(writable, 'a')).data)).toBe(
      String.fromCharCode(1)
    );
  });

  it('supports checkpoint restore and command idempotency', async () => {
    let calls = 0;
    const sandbox = new InMemorySandbox({
      now: () => 100,
      exec: async () => {
        calls += 1;
        return {
          exitCode: 0,
          stdout: `call ${calls}`,
          stderr: '',
          durationMs: 1,
          stdoutTruncated: false,
          stderrTruncated: false,
        };
      },
    });
    const lease = await sandbox.createWorkspace({ sessionId: 's' });
    await sandbox.writeFile(lease, 'a', new Uint8Array([1]));
    const checkpoint = await sandbox.checkpoint(lease);
    await sandbox.writeFile(lease, 'b', new Uint8Array([2]));
    await sandbox.restore(lease, checkpoint.checkpointId);
    await expect(sandbox.readFile(lease, 'b')).rejects.toMatchObject({
      code: 'SANDBOX_FILE_NOT_FOUND',
    });

    const first = await sandbox.exec(lease, {
      command: 'echo',
      args: ['ok'],
      idempotencyKey: 'exec-1',
    });
    const second = await sandbox.exec(lease, {
      command: 'echo',
      args: ['ok'],
      idempotencyKey: 'exec-1',
    });
    expect(second).toEqual(first);
    expect(calls).toBe(1);
  });

  it('aborts and times out commands and denies network by default', async () => {
    const sandbox = new InMemorySandbox({
      exec: async (request) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener(
            'abort',
            () => reject(new Error('aborted')),
            { once: true }
          );
        }),
    });
    const lease = await sandbox.createWorkspace({ sessionId: 's' });
    const controller = new AbortController();
    const pending = sandbox.exec(lease, {
      command: 'sleep',
      timeoutMs: 5,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(() => sandbox.allowNetwork(lease, 'example.com')).toThrowError(/network access is disabled/);
  });

  it('provides cancellable, idempotent PTY sessions released with the workspace', async () => {
    const sandbox = new InMemorySandbox();
    const lease = await sandbox.createWorkspace({ sessionId: 's' });
    const pty = await sandbox.openPty!(lease, { command: 'sh' });
    expect(await pty.read()).toEqual([
      { type: 'data', stream: 'stdout', data: '$ sh\r\n' },
    ]);
    await pty.write('echo hello\n');
    expect(await pty.read()).toEqual([
      { type: 'data', stream: 'stdout', data: 'echo hello\r\n' },
    ]);
    await pty.close();
    await pty.close();
    await expect(pty.write('ignored')).rejects.toMatchObject({ code: 'PTY_CLOSED' });
    const second = await sandbox.openPty!(lease, { command: 'sh' });
    await sandbox.release(lease);
    await expect(second.read()).rejects.toMatchObject({ code: 'PTY_CLOSED' });
  });
});
