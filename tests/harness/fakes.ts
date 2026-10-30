import type {
  ApprovalPort,
  ApprovalRequest,
  Clock,
  JsonValue,
  ModelEvent,
  ModelRequest,
  ModelTransport,
  ToolDefinition,
} from '../../src/core';

export class FakeClock implements Clock {
  private current = 1_700_000_000_000;
  private readonly timers = new Map<number, { callback: () => void; delayMs: number }>();
  private nextTimer = 1;

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextTimer++;
    this.timers.set(id, { callback, delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(Number(handle));
  }

  advance(ms: number): void {
    this.current += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.delayMs <= ms) {
        this.timers.delete(id);
        timer.callback();
      } else {
        this.timers.set(id, { ...timer, delayMs: timer.delayMs - ms });
      }
    }
  }
}

export type FakeModelHandler = (
  request: ModelRequest,
  callIndex: number
) => AsyncIterable<ModelEvent> | Promise<AsyncIterable<ModelEvent>>;

export class FakeModelTransport implements ModelTransport {
  readonly requests: ModelRequest[] = [];

  constructor(private readonly handler: FakeModelHandler) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    const index = this.requests.length;
    this.requests.push(request);
    const events = await this.handler(request, index);
    for await (const event of events) {
      if (request.signal.aborted) throw abortError();
      yield event;
    }
  }
}

export class FakeApproval implements ApprovalPort {
  readonly requests: ApprovalRequest[] = [];

  constructor(private readonly decision: boolean | ((request: ApprovalRequest) => boolean) = false) {}

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) throw abortError();
    this.requests.push(request);
    return typeof this.decision === 'boolean' ? this.decision : this.decision(request);
  }
}

export function readTool(
  name = 'read',
  execute: (input: JsonValue) => Promise<JsonValue> = async () => 'ok'
): ToolDefinition {
  return {
    name,
    description: `Fake ${name} tool`,
    risk: 'read',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
    },
    execute,
  };
}

export function writeTool(name = 'write'): ToolDefinition {
  return {
    name,
    description: `Fake ${name} tool`,
    risk: 'write',
    parameters: {
      type: 'object',
      properties: {},
    },
    execute: async () => 'written',
  };
}

export async function* events(...items: ModelEvent[]): AsyncIterable<ModelEvent> {
  for (const item of items) yield item;
}

export function text(value: string): ModelEvent[] {
  return [
    { type: 'text_delta', text: value },
    { type: 'finish', reason: 'stop' },
  ];
}

export function toolCall(id: string, name: string, args: unknown): ModelEvent[] {
  return [
    {
      type: 'tool_call',
      call: { id, name, arguments: JSON.stringify(args) },
    },
    { type: 'finish', reason: 'tool_calls' },
  ];
}

export async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Condition was not met before timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}
