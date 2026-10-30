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

  constructor(
    readonly logEpoch: string,
    private readonly now: () => number
  ) {}

  append(type: string, revision: number, payload?: JsonValue): RuntimeEvent {
    const event: RuntimeEvent = {
      seq: this.events.length + 1,
      type,
      revision,
      occurredAt: this.now(),
      ...(payload === undefined ? {} : { payload }),
    };
    this.events.push(event);
    return { ...event };
  }

  get seq(): number {
    return this.events.length;
  }

  list(): RuntimeEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  restore(events: readonly RuntimeEvent[]): void {
    this.events = events.map((event) => ({ ...event }));
  }
}
