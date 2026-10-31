import { describe, expect, it, vi } from 'vitest';
import {
  RenderScheduler,
  type RenderTimerApi,
} from '../../src/node/render-scheduler';

class Timers implements RenderTimerApi {
  private sequence = 0;
  readonly callbacks = new Map<number, () => void>();

  setTimeout(callback: () => void): unknown {
    const id = ++this.sequence;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runAll(): void {
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback();
  }
}

describe('RenderScheduler', () => {
  it('coalesces a burst of updates into one render', () => {
    const timers = new Timers();
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, 33, timers);

    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(render).not.toHaveBeenCalled();
    timers.runAll();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('flushes immediately and suppresses work after disposal', () => {
    const timers = new Timers();
    const render = vi.fn();
    const scheduler = new RenderScheduler(render, 33, timers);

    scheduler.schedule();
    scheduler.flush();
    expect(render).toHaveBeenCalledTimes(1);
    scheduler.schedule();
    scheduler.dispose();
    timers.runAll();
    expect(render).toHaveBeenCalledTimes(1);
  });
});
