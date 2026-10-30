import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, type ProductProjection } from '../../src/core';
import { events, readTool, text, toolCall } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

function stable(projection: ProductProjection) {
  return {
    sessionId: projection.sessionId,
    phase: projection.phase,
    taskStatus: projection.taskStatus,
    inputRouting: projection.inputRouting,
    queueLength: projection.queueLength,
    permissionMode: projection.permissionMode,
    availability: projection.availability,
    rows: projection.rows.map((row) => ({
      kind: row.kind,
      text: row.text,
      status: row.status,
      ...(row.toolName ? { toolName: row.toolName } : {}),
    })),
  };
}

describe('projection golden', () => {
  it('makes live and cold hydration converge on the same product facts', async () => {
    const store = new InMemorySessionStore();
    const first = createTestWorkspace({
      model: async (_request, index) =>
        events(
          ...(index === 0
            ? toolCall('read_1', 'read', { text: 'body' })
            : text('Golden complete.'))
        ),
      tools: [readTool('read', async () => 'golden page')],
      sessionStore: store,
    });
    await first.runtime.command(command('session_1', 'command_1', 'Read the golden page'));
    await first.runtime.waitForSessionIdle('session_1');
    await first.runtime.flush('session_1');
    const live = stable(first.runtime.getProjection('session_1'));
    const expected = JSON.parse(
      await readFile(new URL('../golden/projections/basic-tool-loop.json', import.meta.url), 'utf8')
    );
    expect(live).toEqual(expected);

    const second = createTestWorkspace({
      model: async () => events(...text('unused')),
      tools: [],
      sessionStore: store,
    });
    await second.runtime.hydrateSession('session_1');
    await second.runtime.ensureSessionReady('session_1');
    expect(stable(second.runtime.getProjection('session_1'))).toEqual(live);
    expect(second.model.requests).toHaveLength(0);
  });
});
