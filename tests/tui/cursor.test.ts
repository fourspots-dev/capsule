import { describe, expect, it } from 'vitest';
import {
  deleteBackward,
  deleteForward,
  graphemeBoundaries,
  insertAtCursor,
  moveCursor,
} from '../../src/tui';

describe('TUI cursor editing', () => {
  it('moves across grapheme boundaries and edits at the cursor', () => {
    const value = 'a👨‍👩‍👧‍👦e\u0301中';
    const boundaries = graphemeBoundaries(value);
    expect(boundaries).toContain(0);
    expect(boundaries).toContain(1);
    expect(boundaries.at(-1)).toBe(value.length);

    let offset = moveCursor(value, value.length, 'home');
    expect(offset).toBe(0);
    offset = moveCursor(value, offset, 'right');
    expect(offset).toBe(1);
    offset = moveCursor(value, offset, 'right');
    expect(value.slice(1, offset)).toBe('👨‍👩‍👧‍👦');
    offset = moveCursor(value, offset, 'left');
    expect(offset).toBe(1);
  });

  it('inserts, deletes backward and deletes forward without breaking surrogate pairs', () => {
    const inserted = insertAtCursor('ac', 1, 'b');
    expect(inserted).toEqual({ value: 'abc', cursor: 2 });

    const backward = deleteBackward('a👨‍👩‍👧‍👦b', 12);
    expect(backward.value).toBe('ab');
    expect(backward.cursor).toBe(1);

    const forward = deleteForward('a👨‍👩‍👧‍👦b', 1);
    expect(forward.value).toBe('ab');
    expect(forward.cursor).toBe(1);
  });
});
