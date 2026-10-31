import type { TuiApp } from '../tui/app';
import type { NodeTerminal } from './node-host';

export interface RunNodeTuiOptions {
  refreshIntervalMs?: number;
}

export async function runNodeTui(
  app: TuiApp,
  terminal: NodeTerminal,
  options: RunNodeTuiOptions = {}
): Promise<void> {
  terminal.start();
  let pending: Promise<void> = Promise.resolve();
  let disposed = false;
  const render = () => {
    const size = terminal.size();
    const lines = app.render(size.columns, size.rows);
    terminal.write(`\x1b[H\x1b[2J${lines.join('\n')}`);
  };
  const stop = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
    removeInput();
    removeResize();
    removeRender();
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
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
        render();
      })
      .catch((error) => {
        terminal.write(
          `\x1b[H\x1b[2J${formatFatal(error, terminal.size().columns)}`
        );
      });
  });
  const removeResize = terminal.onResize(render);
  const removeRender = app.onRender(render);
  const timer = setInterval(render, options.refreshIntervalMs ?? 1_000);
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  render();
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
