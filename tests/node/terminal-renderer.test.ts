import { describe, expect, it } from 'vitest';
import { buildFrameUpdate } from '../../src/node/terminal-renderer';

describe('terminal frame renderer', () => {
  it('writes an initial frame without clearing the whole screen', () => {
    const update = buildFrameUpdate([], ['first', 'second']);

    expect(update).toContain('\x1b[1;1H\x1b[2Kfirst');
    expect(update).toContain('\x1b[2;1H\x1b[2Ksecond');
    expect(update).not.toContain('\x1b[2J');
    expect(update).not.toContain('\x1b[H');
  });

  it('updates only dirty rows and skips repeated frames', () => {
    const update = buildFrameUpdate(['one', 'two', 'three'], [
      'one',
      'changed',
      'three',
    ]);

    expect(update).not.toContain('one');
    expect(update).toContain('\x1b[2;1H\x1b[2Kchanged');
    expect(update).not.toContain('three');
    expect(
      buildFrameUpdate(['one', 'two'], ['one', 'two'])
    ).toBe('');
  });

  it('forces a complete frame after a resize', () => {
    const update = buildFrameUpdate(['one', 'two'], ['one', 'two'], true);

    expect(update).toContain('\x1b[1;1H\x1b[2Kone');
    expect(update).toContain('\x1b[2;1H\x1b[2Ktwo');
  });
});
