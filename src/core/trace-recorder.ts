import type { JsonValue, StructuredError } from './types';

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  attributes: Record<string, JsonValue>;
  error?: StructuredError;
}

export class TraceRecorder {
  private readonly spans: TraceSpan[] = [];
  private sequence = 0;

  constructor(
    readonly traceId: string,
    private readonly now: () => number = () => Date.now()
  ) {}

  start(
    name: string,
    attributes: Record<string, JsonValue> = {},
    parentSpanId?: string
  ): TraceSpan {
    const span: TraceSpan = {
      traceId: this.traceId,
      spanId: `span_${++this.sequence}`,
      ...(parentSpanId ? { parentSpanId } : {}),
      name,
      startedAt: this.now(),
      attributes: { ...attributes },
    };
    this.spans.push(span);
    return { ...span, attributes: { ...span.attributes } };
  }

  end(
    spanId: string,
    attributes: Record<string, JsonValue> = {},
    error?: StructuredError
  ): TraceSpan {
    const span = this.spans.find((candidate) => candidate.spanId === spanId);
    if (!span) throw new Error(`Trace span not found: ${spanId}`);
    span.endedAt = this.now();
    span.durationMs = span.endedAt - span.startedAt;
    span.attributes = { ...span.attributes, ...attributes };
    if (error) span.error = { ...error };
    return structuredClone(span);
  }

  list(): TraceSpan[] {
    return this.spans.map((span) => structuredClone(span));
  }

  json(): JsonValue {
    return {
      traceId: this.traceId,
      spans: this.list() as unknown as JsonValue,
    };
  }
}
