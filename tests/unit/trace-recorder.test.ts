import { describe, expect, it } from 'vitest';
import { TraceRecorder } from '../../src/core/trace-recorder';

describe('TraceRecorder', () => {
  it('records parented spans, timing and structured errors as reviewable evidence', () => {
    let now = 10;
    const trace = new TraceRecorder('trace_1', () => now);
    const run = trace.start('agent.run', { sessionId: 's' });
    now = 12;
    const tool = trace.start('tool.call', { toolName: 'read' }, run.spanId);
    now = 15;
    expect(trace.end(tool.spanId, { bytes: 10 })).toMatchObject({
      parentSpanId: 'span_1',
      durationMs: 3,
      attributes: { toolName: 'read', bytes: 10 },
    });
    now = 20;
    expect(
      trace.end(run.spanId, {}, {
        code: 'AGENT_FAILED',
        message: 'failed',
        retryable: false,
      })
    ).toMatchObject({
      durationMs: 10,
      error: { code: 'AGENT_FAILED' },
    });
    expect(trace.json()).toMatchObject({ traceId: 'trace_1', spans: expect.any(Array) });
  });
});
