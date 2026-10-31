import { describe, expect, it } from 'vitest';
import { events, text } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';
import { MemoryHostBridge } from '../../src/host';
import { VirtualWorkspace } from '../../src/virtual';

const enabled = process.env.TINYAI_SOAK === '1';
const durationMs = Math.max(
  10_000,
  Number(process.env.TINYAI_SOAK_DURATION_MS ?? 60_000)
);
const intervalMs = Math.max(
  10,
  Number(process.env.TINYAI_SOAK_INTERVAL_MS ?? 1_000)
);
const soakTest = enabled ? it : it.skip;
const encoder = new TextEncoder();

describe('production Soak', () => {
  soakTest(
    'keeps workspace, VCS, jobs and sessions stable under repeated load',
    async () => {
      const startedAt = Date.now();
      const initialHeap = process.memoryUsage().heapUsed;
      const workspace = new VirtualWorkspace({
        host: new MemoryHostBridge(),
        storageKey: `soak:${startedAt}`,
      });
      await workspace.fs.write(
        'src/main.ts',
        encoder.encode('export const value = 0;\n')
      );
      const sessions = createTestWorkspace({
        model: async (_request, index) =>
          events(...text(`soak response ${index}`)),
        tools: [],
      });
      let cycle = 0;
      while (Date.now() - startedAt < durationMs) {
        const revision = cycle % 100;
        await workspace.fs.write(
          'src/main.ts',
          encoder.encode(`export const value = ${revision};\n`)
        );
        if (cycle % 10 === 0) {
          await workspace.checkpoint(`soak-${cycle}`);
        }
        if (cycle % 25 === 0) {
          const job = await workspace.jobs.start(`echo soak-${cycle}`);
          await expect(workspace.jobs.wait(job.id)).resolves.toMatchObject({
            status: 'completed',
          });
        }
        if (cycle % 5 === 0) {
          const sessionId = `soak_session_${cycle % 8}`;
          const ack = await sessions.runtime.command(
            command(sessionId, `soak_command_${cycle}`, `cycle ${cycle}`)
          );
          expect(ack.status).toBe('accepted');
          await sessions.runtime.waitForSessionIdle(sessionId);
        }
        if (cycle % 100 === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
        cycle += 1;
      }
      const status = await workspace.status();
      expect(status.fileCount).toBe(1);
      expect((await workspace.vcs.list()).length).toBeGreaterThan(0);
      expect(await workspace.jobs.list()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ status: 'completed' }),
        ])
      );
      expect((await sessions.runtime.listSessions()).length).toBeLessThanOrEqual(8);
      const heapGrowth = process.memoryUsage().heapUsed - initialHeap;
      expect(heapGrowth).toBeLessThan(512 * 1024 * 1024);
      process.stdout.write(
        `Soak completed: ${cycle} cycles in ${Date.now() - startedAt}ms (${intervalMs}ms interval), heap growth ${Math.round(heapGrowth / 1024 / 1024)}MB\n`
      );
      await workspace.jobs.dispose();
      await sessions.runtime.dispose();
    },
    durationMs + 60_000
  );
});
