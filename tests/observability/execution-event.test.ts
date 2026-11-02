import { describe, expect, it } from 'vitest';
import {
  decodeExecutionCursor,
  encodeExecutionCursor,
  redactExecutionValue,
} from '../../src/observability/execution-event';

describe('REQ-OBS-001 execution event protocol', () => {
  it('round-trips opaque cursors and rejects malformed values', () => {
    const cursor = encodeExecutionCursor({
      version: 1,
      epoch: 'epoch_1',
      sequence: 42,
    });
    expect(cursor).not.toContain('=');
    expect(decodeExecutionCursor(cursor)).toEqual({
      version: 1,
      epoch: 'epoch_1',
      sequence: 42,
    });
    expect(() => decodeExecutionCursor('not-a-cursor')).toThrow(
      'Invalid execution cursor'
    );
  });

  it('redacts structured secrets and token-shaped text', () => {
    expect(
      redactExecutionValue({
        apiKey: 'sk-secret-value',
        nested: {
          authorization: 'Bearer abc',
          safe: 'request failed with Bearer abc.def',
        },
        text: 'key=sk-1234567890',
      })
    ).toEqual({
      apiKey: '[REDACTED]',
      nested: {
        authorization: '[REDACTED]',
        safe: 'request failed with Bearer [REDACTED]',
      },
      text: 'key=[REDACTED]',
    });
  });
});
