import type { TuiApp } from '../tui/app';
import type { NodeTerminal } from './node-host';
import { RenderScheduler } from './render-scheduler';
import { TerminalCursorController } from './terminal-cursor';
import { buildFrameUpdate } from './terminal-renderer';

export interface RunNodeTuiOptions {
  refreshIntervalMs?: number;
}

export async function runNodeTui(
  app: TuiApp,
  terminal: NodeTerminal,
  options: RunNodeTuiOptions = {}
): Promise<void> {
  terminal.start();
  const cursor = new TerminalCursorController(terminal);
  let pending: Promise<void> = Promise.resolve();
  let disposed = false;
  let previousFrame: string[] = [];
  let previousSize = '';
  let previousCursor = '';
  const render = () => {
    const size = terminal.size();
    const frame = app.renderFrame(size.columns, size.rows);
    const cacheKey = `${size.columns}x${size.rows}`;
    const update = buildFrameUpdate(
      previousFrame,
      frame.lines,
      previousSize !== cacheKey
    );
    const cursorKey = JSON.stringify(frame.cursor);
    if (update || cursorKey !== previousCursor) {
      cursor.hide();
      if (update) terminal.write(update);
      cursor.place(frame.cursor);
    }
    previousFrame = frame.lines;
    previousSize = cacheKey;
    previousCursor = cursorKey;
  };
  const renderSafely = () => {
    try {
      render();
    } catch (error) {
      cursor.hide(true);
      terminal.write(
        `\x1b[H\x1b[2J${formatFatal(error, terminal.size().columns)}`
      );
    }
  };
  const scheduler = new RenderScheduler(renderSafely);
  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    removeInput();
    removeResize();
    removeRender();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    scheduler.dispose();
    cursor.dispose();
    terminal.stop();
  };
  const removeInput = terminal.onInput((data) => {
    pending = pending
      .then(() => app.handleInput(data))
      .then(() => {
        if (app.exitRequested) {
          stop();
          return;
        }
        scheduler.schedule();
      })
      .catch((error) => {
        cursor.hide(true);
        terminal.write(
          `\x1b[H\x1b[2J${formatFatal(error, terminal.size().columns)}`
        );
      });
  });
  const removeResize = terminal.onResize(() => scheduler.schedule());
  const removeRender = app.onRender(() => scheduler.schedule());
  const timer = setInterval(
    () => scheduler.schedule(),
    options.refreshIntervalMs ?? 250
  );
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  scheduler.flush();
  while (!disposed) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await pending;
  await app.dispose();
}

function formatFatal(error: unknown, width: number): string {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  return message
    .split('\n')
    .map((line) => line.slice(0, width))
    .join('\n');
}
