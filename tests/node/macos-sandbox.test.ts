import { existsSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MacOSSeatbeltSandbox } from '../../src/node/macos-sandbox';

const onMac = process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec');

describe.skipIf(!onMac)('MacOSSeatbeltSandbox', () => {
  it('runs real local processes in a leased workspace and enforces file boundaries', async () => {
    const sandbox = new MacOSSeatbeltSandbox({ defaultTimeoutMs: 5_000 });
    const lease = await sandbox.createWorkspace({ sessionId: 'local' });
    try {
      await sandbox.writeFile(
        lease,
        'src/value.txt',
        new TextEncoder().encode('local sandbox')
      );
      const result = await sandbox.exec(lease, {
        command: '/bin/cat',
        args: ['src/value.txt'],
      });
      expect(result).toMatchObject({ exitCode: 0, stdout: 'local sandbox' });
      expect(
        new TextDecoder().decode((await sandbox.readFile(lease, 'src/value.txt')).data)
      ).toBe('local sandbox');
      expect((await sandbox.listFiles(lease)).map((file) => file.path)).toEqual([
        'src/value.txt',
      ]);

      const escapePath = join(tmpdir(), `tinyai-seatbelt-escape-${process.pid}`);
      const escape = await sandbox.exec(lease, {
        command: '/bin/sh',
        args: ['-c', `printf bad > ${escapePath}`],
      });
      expect(escape.exitCode).not.toBe(0);
      expect(existsSync(escapePath)).toBe(false);

      const outside = await mkdtemp(join(tmpdir(), 'tinyai-outside-'));
      await writeFile(join(outside, 'value'), 'outside');
      await symlink(outside, join(lease.workspaceRoot, 'escape-link'));
      await expect(sandbox.readFile(lease, 'escape-link/value')).rejects.toMatchObject({
        code: 'SANDBOX_PATH_ESCAPE',
      });
      await rm(outside, { recursive: true, force: true });
    } finally {
      const root = lease.workspaceRoot;
      await sandbox.release(lease);
      expect(existsSync(root)).toBe(false);
    }
  });

  it('denies network and enforces command timeout in the real Seatbelt profile', async () => {
    const sandbox = new MacOSSeatbeltSandbox({ defaultTimeoutMs: 2_000 });
    const lease = await sandbox.createWorkspace({ sessionId: 'local' });
    try {
      const network = await sandbox.exec(lease, {
        command: '/usr/bin/curl',
        args: ['-sS', '--max-time', '2', 'https://example.com'],
        timeoutMs: 4_000,
      });
      expect(network.exitCode).not.toBe(0);
      expect(`${network.stderr}${network.stdout}`).toMatch(
        /not permitted|Operation not permitted|Could not connect|Failed to connect|Could not resolve host/i
      );
      await expect(
        sandbox.exec(lease, {
          command: '/bin/sleep',
          args: ['10'],
          timeoutMs: 100,
        })
      ).rejects.toMatchObject({ code: 'SANDBOX_EXEC_TIMEOUT' });
    } finally {
      await sandbox.release(lease);
    }
  });

  it('supports checkpoint restore and an interactive local PTY', async () => {
    const sandbox = new MacOSSeatbeltSandbox();
    const lease = await sandbox.createWorkspace({ sessionId: 'local' });
    try {
      await sandbox.writeFile(lease, 'a.txt', new TextEncoder().encode('one'));
      const checkpoint = await sandbox.checkpoint(lease);
      await sandbox.writeFile(lease, 'b.txt', new TextEncoder().encode('two'));
      await sandbox.restore(lease, checkpoint.checkpointId);
      expect((await sandbox.listFiles(lease)).map((file) => file.path)).toEqual(['a.txt']);

      const pty = await sandbox.openPty!(lease, { command: '/bin/sh' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await pty.write('printf pty-ok\\n\n');
      await new Promise((resolve) => setTimeout(resolve, 100));
      const output = await pty.read();
      expect(
        output
          .filter((event) => event.type === 'data')
          .map((event) => event.data)
          .join('')
      ).toContain('pty-ok');
      await pty.close();
    } finally {
      await sandbox.release(lease);
    }
  });
});
