import { act } from '@testing-library/react';

/**
 * A fake `requestIdleCallback`: callbacks wait until the test says the browser
 * is idle, so a test decides exactly when each idle-gated step may run.
 *
 * happy-dom has no idle callback, so without this the code under test falls back
 * to a plain timer; installing this exercises the real path.
 *
 * @example
 * const idle = new FakeIdleScheduler().install();
 * try {
 *   // ... render ...
 *   expect(idle.pending).toBe(1);
 *   await idle.runIdle();
 * } finally {
 *   idle.restore();
 * }
 */
export class FakeIdleScheduler {
  /** The `timeout` option of every callback requested, in order. */
  readonly timeouts: number[] = [];
  private readonly callbacks = new Map<number, () => void>();
  private nextHandle = 1;
  private readonly original = {
    request: (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback,
    cancel: (globalThis as { cancelIdleCallback?: unknown }).cancelIdleCallback,
  };

  /** Callbacks requested and neither run nor cancelled. */
  get pending(): number {
    return this.callbacks.size;
  }

  install(): this {
    const host = globalThis as Record<string, unknown>;
    host.requestIdleCallback = (callback: () => void, options?: { timeout: number }) => {
      const handle = this.nextHandle++;
      this.timeouts.push(options?.timeout ?? Number.NaN);
      this.callbacks.set(handle, callback);
      return handle;
    };
    host.cancelIdleCallback = (handle: number) => {
      this.callbacks.delete(handle);
    };
    return this;
  }

  restore(): void {
    const host = globalThis as Record<string, unknown>;
    host.requestIdleCallback = this.original.request;
    host.cancelIdleCallback = this.original.cancel;
    this.callbacks.clear();
  }

  /** Runs every callback waiting now (not the ones they request) and flushes React. */
  async runIdle(): Promise<void> {
    const waiting = [...this.callbacks.entries()];
    this.callbacks.clear();
    await act(async () => {
      for (const [, callback] of waiting) callback();
      await Promise.resolve();
    });
  }
}
