export interface TerminalCursorTarget {
  row: number;
  column: number;
  visible: boolean;
  shape?: 'bar' | 'block';
}

export interface CursorWriter {
  write(data: string): void;
}

export class TerminalCursorController {
  private shown = false;
  private shape?: 'bar' | 'block';

  constructor(private readonly writer: CursorWriter) {}

  hide(force = false): void {
    if (!this.shown && !force) return;
    this.writer.write('\x1b[?25l');
    this.shown = false;
  }

  place(target: TerminalCursorTarget | undefined): void {
    if (!target?.visible) {
      this.hide();
      return;
    }
    const row = Math.max(1, Math.trunc(target.row));
    const column = Math.max(1, Math.trunc(target.column));
    const shape = target.shape ?? 'block';
    let output = `\x1b[${row};${column}H`;
    if (this.shape !== shape) {
      output += shape === 'block' ? '\x1b[1 q' : '\x1b[5 q';
      this.shape = shape;
    }
    output += '\x1b[?25h';
    this.writer.write(output);
    this.shown = true;
  }

  dispose(): void {
    this.hide();
  }
}
