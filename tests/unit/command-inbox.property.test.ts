import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CommandAck, CommandEnvelope } from '../../src/core';
import { CommandInbox } from '../../src/core';

function envelope(commandId: string): CommandEnvelope {
  return {
    commandId,
    clientId: 'property-client',
    sessionId: 'property-session',
    type: 'send_input',
    payload: { text: 'hello' },
    issuedAt: 1,
  };
}

function accepted(command: CommandEnvelope): CommandAck {
  return {
    commandId: command.commandId,
    sessionId: command.sessionId,
    status: 'accepted',
    revision: 1,
  };
}

describe('CommandInbox properties', () => {
  it('invokes the handler once for any number of concurrent submissions with one command id', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.integer({ min: 2, max: 24 }),
        async (commandId, submissions) => {
          const inbox = new CommandInbox();
          let calls = 0;
          const handler = async (command: CommandEnvelope) => {
            calls += 1;
            await Promise.resolve();
            return accepted(command);
          };
          const command = envelope(commandId);
          const acks = await Promise.all(
            Array.from({ length: submissions }, () => inbox.submit(command, handler))
          );

          expect(calls).toBe(1);
          expect(acks.filter((ack) => ack.status === 'accepted')).toHaveLength(1);
          expect(acks.filter((ack) => ack.status === 'duplicate')).toHaveLength(
            submissions - 1
          );
          expect(inbox.query(commandId)).toMatchObject({
            commandId,
            status: 'accepted',
            revision: 1,
          });
        }
      ),
      { numRuns: 80 }
    );
  });

  it('runs distinct command ids once each and in submission order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 24 }), {
          minLength: 2,
          maxLength: 16,
        }),
        async (commandIds) => {
          const inbox = new CommandInbox();
          const completed: string[] = [];
          const commands = commandIds.map(envelope);
          const acks = await Promise.all(
            commands.map((command) =>
              inbox.submit(command, async (current) => {
                await Promise.resolve();
                completed.push(current.commandId);
                return accepted(current);
              })
            )
          );

          expect(completed).toEqual(commandIds);
          expect(acks.every((ack) => ack.status === 'accepted')).toBe(true);
        }
      ),
      { numRuns: 80 }
    );
  });
});
