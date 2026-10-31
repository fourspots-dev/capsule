import { describe, expect, it } from 'vitest';
import {
  TerminalCursorController,
  type CursorWriter,
} from '../../src/node/terminal-cursor';

class Writer implements CursorWriter {
  output = '';
  write(data: string): void {
    this.output += data;
  }
}

describe('TerminalCursorController', () => {
  it('positions and shows a blinking bar only when requested', () => {
    const writer = new Writer();
    const cursor = new TerminalCursorController(writer);

    cursor.place({ row: 12, column: 5, visible: true, shape: 'block' });
    expect(writer.output).toBe('\x1b[12;5H\x1b[1 q\x1b[?25h');

    writer.output = '';
    cursor.place({ row: 12, column: 8, visible: true, shape: 'block' });
    expect(writer.output).toBe('\x1b[12;8H\x1b[?25h');
  });

  it('hides the cursor for overlays and restores a block shape', () => {
    const writer = new Writer();
    const cursor = new TerminalCursorController(writer);

    cursor.place({ row: 1, column: 1, visible: true, shape: 'block' });
    writer.output = '';
    cursor.place({ row: 1, column: 1, visible: false });
    expect(writer.output).toBe('\x1b[?25l');

    writer.output = '';
    cursor.place({ row: 8, column: 3, visible: true, shape: 'block' });
    expect(writer.output).toBe('\x1b[8;3H\x1b[?25h');
  });
});
