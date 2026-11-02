import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { ExecutionEvent } from '../observability/execution-event';
import type { ExecutionEventStore } from '../observability/execution-hub';

interface StoreMetadata {
  schemaVersion: 1;
  epoch: string;
}

export class NdjsonExecutionLogStore implements ExecutionEventStore {
  private readonly file: string;
  private readonly metadataFile: string;
  private readonly events: ExecutionEvent[] = [];
  private epoch?: string;
  private appendTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly dataDir: string,
    private readonly maxEvents = 100_000
  ) {
    this.file = join(resolve(dataDir), 'events.ndjson');
    this.metadataFile = join(resolve(dataDir), 'metadata.json');
  }

  async load(): Promise<{ epoch?: string; events: ExecutionEvent[] }> {
    await mkdir(dirname(this.file), { recursive: true });
    try {
      const metadata = JSON.parse(
        await readFile(this.metadataFile, 'utf8')
      ) as StoreMetadata;
      if (metadata.schemaVersion === 1 && typeof metadata.epoch === 'string') {
        this.epoch = metadata.epoch;
      }
    } catch {
      // A new debug directory starts with a fresh epoch in the Hub.
    }
    try {
      const lines = (await readFile(this.file, 'utf8')).split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ExecutionEvent;
          if (
            event.schemaVersion === 1 &&
            typeof event.sequence === 'number' &&
            typeof event.sessionId === 'string'
          ) {
            this.events.push(event);
          }
        } catch {
          // Ignore a partial final line after an abrupt process exit.
        }
      }
    } catch {
      // The file may not exist yet.
    }
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
      await this.compact();
    }
    return {
      ...(this.epoch ? { epoch: this.epoch } : {}),
      events: this.events.map((event) => structuredClone(event)),
    };
  }

  setEpoch(epoch: string): Promise<void> {
    this.epoch = epoch;
    return this.writeMetadata();
  }

  append(event: ExecutionEvent): Promise<void> {
    this.events.push(structuredClone(event));
    this.appendTail = this.appendTail.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      if (!this.epoch) await this.writeMetadata();
      await appendFile(this.file, `\n${JSON.stringify(event)}\n`, 'utf8');
      if (this.events.length > this.maxEvents * 1.5) {
        this.events.splice(
          0,
          this.events.length - this.maxEvents
        );
        await this.compact();
      }
    });
    return this.appendTail;
  }

  private async compact(): Promise<void> {
    const temporary = `${this.file}.tmp`;
    await writeFile(
      temporary,
      this.events.map((event) => JSON.stringify(event)).join('\n') + '\n',
      'utf8'
    );
    await rename(temporary, this.file);
  }

  private async writeMetadata(): Promise<void> {
    await mkdir(dirname(this.metadataFile), { recursive: true });
    await writeFile(
      this.metadataFile,
      JSON.stringify({
        schemaVersion: 1,
        epoch: this.epoch ?? '',
      } satisfies StoreMetadata),
      'utf8'
    );
  }
}
