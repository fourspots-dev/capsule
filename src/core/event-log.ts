import type { JsonValue } from './types';

export interface RuntimeEvent {
  seq: number;
  type: string;
  revision: number;
  occurredAt: number;
  payload?: JsonValue;
}

export class EventLog {
  private events: RuntimeEvent[] = [];
  private nextSequence = 1;

  constructor(
    readonly logEpoch: string,
    private readonly now: () => number,
    private readonly maxEvents = Number.POSITIVE_INFINITY
  ) {}

  append(type: string, revision: number, payload?: JsonValue): RuntimeEvent {
    const event: RuntimeEvent = {
      seq: this.nextSequence++,
      type,
      revision,
      occurredAt: this.now(),
      ...(payload === undefined ? {} : { payload }),
    };
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return { ...event };
  }

  get seq(): number {
    return this.nextSequence - 1;
  }

  list(): RuntimeEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  restore(events: readonly RuntimeEvent[]): void {
    this.events = events.map((event) => ({ ...event }));
    this.nextSequence =
      events.reduce((maximum, event) => Math.max(maximum, event.seq), 0) + 1;
  }
}
