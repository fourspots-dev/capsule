export interface RenderTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const nodeTimers: RenderTimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class RenderScheduler {
  private handle: unknown;
  private disposed = false;

  constructor(
    private readonly render: () => void,
    private readonly delayMs = 33,
    private readonly timers: RenderTimerApi = nodeTimers
  ) {}

  schedule(): void {
    if (this.disposed || this.handle !== undefined) return;
    this.handle = this.timers.setTimeout(() => {
      this.handle = undefined;
      if (!this.disposed) this.render();
    }, this.delayMs);
  }

  flush(): void {
    if (this.disposed) return;
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
    this.render();
  }

  dispose(): void {
    this.disposed = true;
    if (this.handle !== undefined) {
      this.timers.clearTimeout(this.handle);
      this.handle = undefined;
    }
  }
}
