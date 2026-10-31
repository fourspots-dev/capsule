import { describe, expect, it } from 'vitest';
import { createRuntimePortPair } from '../../src/headless';
import { HeadlessRuntimeClient } from '../../src/headless';
import { RuntimeGateway } from '../../src/runtime/runtime-gateway';
import { events, text, until } from '../harness/fakes';
import { command, createTestWorkspace } from '../harness/workspace';

describe('HeadlessRuntimeClient', () => {
  it('starts, controls a session and receives projection events over a generic RuntimePort', async () => {
    const harness = createTestWorkspace({
      model: async () => events(...text('headless answer')),
      tools: [],
    });
    const gateway = new RuntimeGateway(async () => ({
      runtime: harness.runtime,
      async dispose() {
        await harness.runtime.dispose();
      },
    }));
    const pair = createRuntimePortPair();
    const disconnectGateway = gateway.connect(pair.server);
    const client = new HeadlessRuntimeClient(() => pair.client, {
      clientId: 'headless-test',
    });
    await client.connect();
    expect(await client.listSessions()).toEqual([]);

    const ack = await client.command(
      command('session_headless', 'headless_command', 'do work')
    );
    expect(ack).toMatchObject({ status: 'accepted' });
    await harness.runtime.waitForSessionIdle('session_headless');
    await client.rename('session_headless', 'Headless work');
    const projection = await client.subscribe('session_headless');
    expect(projection).toMatchObject({
      sessionId: 'session_headless',
      taskStatus: 'completed',
      rows: expect.arrayContaining([
        expect.objectContaining({ text: 'headless answer' }),
      ]),
    });
    expect(await client.listSessions()).toEqual([
      expect.objectContaining({
        sessionId: 'session_headless',
        title: 'Headless work',
      }),
    ]);

    const updates: string[] = [];
    client.onProjection((sessionId) => updates.push(sessionId));
    await client.command(command('session_headless', 'headless_command_2', 'again'));
    await harness.runtime.waitForSessionIdle('session_headless');
    await until(() => updates.includes('session_headless'));
    await client.stop('session_headless');
    await client.delete('session_headless');
    expect(await client.listSessions()).toEqual([]);
    client.disconnect();
    disconnectGateway();
    pair.dispose();
    await gateway.dispose();
  });
});
