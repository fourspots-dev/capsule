import type { CommandAck, CommandEnvelope } from './types';

interface CommandRecord {
  promise: Promise<CommandAck>;
  ack?: CommandAck;
}

export class CommandInbox {
  private readonly records = new Map<string, CommandRecord>();
  private tail: Promise<void> = Promise.resolve();

  restore(acks: readonly CommandAck[]): void {
    for (const ack of acks) {
      if (this.records.has(ack.commandId)) continue;
      this.records.set(ack.commandId, {
        promise: Promise.resolve({ ...ack }),
        ack: { ...ack },
      });
    }
  }

  submit(
    command: CommandEnvelope,
    handler: (command: CommandEnvelope) => Promise<CommandAck>
  ): Promise<CommandAck> {
    const existing = this.records.get(command.commandId);
    if (existing) {
      return existing.promise.then((ack) => ({
        ...ack,
        status: 'duplicate',
        error: {
          code: 'COMMAND_DUPLICATE',
          message: `Command already received: ${command.commandId}`,
          retryable: false,
        },
      }));
    }

    const record: CommandRecord = {
      promise: Promise.resolve(undefined as never),
    };
    const promise = this.tail.then(() => handler(command)).then((ack) => {
      record.ack = ack;
      return ack;
    });
    record.promise = promise;
    this.tail = promise.then(
      () => undefined,
      () => undefined
    );
    this.records.set(command.commandId, record);
    return promise;
  }

  query(commandId: string): CommandAck | undefined {
    const ack = this.records.get(commandId)?.ack;
    if (!ack) return undefined;
    return {
      ...ack,
      ...(ack.error ? { error: { ...ack.error } } : {}),
    };
  }

  async querySettled(commandId: string): Promise<CommandAck | undefined> {
    const record = this.records.get(commandId);
    if (!record) return undefined;
    return record.promise.catch(() => undefined);
  }

  snapshot(): CommandAck[] {
    return [...this.records.values()]
      .flatMap((record) => (record.ack ? [record.ack] : []))
      .map((ack) => ({
        ...ack,
        ...(ack.error ? { error: { ...ack.error } } : {}),
      }));
  }
}
