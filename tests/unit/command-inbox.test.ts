import { describe, expect, it } from 'vitest';
import type { CommandAck, CommandEnvelope } from '../../src/core';
import { CommandInbox } from '../../src/core';

const envelope: CommandEnvelope = {
  commandId: 'command_1',
  clientId: 'client_1',
  sessionId: 'session_1',
  type: 'send_input',
  payload: { text: 'hello' },
  issuedAt: 1,
};

function accepted(command: CommandEnvelope): CommandAck {
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    status: 'accepted',
    revision: 1,
  };
}

describe('CommandInbox', () => {
  it('serializes commands and shares one in-flight command result', async () => {
    const inbox = new CommandInbox();
    const order: string[] = [];
    const handler = async (command: CommandEnvelope) => {
      order.push(`start:${command.commandId}`);
      await Promise.resolve();
      order.push(`end:${command.commandId}`);
      return accepted(command);
    };

    const first = inbox.submit(envelope, handler);
    const duplicate = inbox.submit(envelope, handler);
    const second = inbox.submit({ ...envelope, commandId: 'command_2' }, handler);
    const [firstAck, duplicateAck, secondAck] = await Promise.all([first, duplicate, second]);

    expect(firstAck.status).toBe('accepted');
    expect(duplicateAck.status).toBe('duplicate');
    expect(secondAck.status).toBe('accepted');
    expect(order).toEqual([
      'start:command_1',
      'end:command_1',
      'start:command_2',
      'end:command_2',
    ]);
  });

  it('can reconcile a lost ACK from the settled command result', async () => {
    const inbox = new CommandInbox();
    await inbox.submit(envelope, async () => accepted(envelope));
    expect(inbox.query('command_1')).toMatchObject({ status: 'accepted', revision: 1 });
    await expect(inbox.querySettled('command_1')).resolves.toMatchObject({ status: 'accepted' });
  });
});
