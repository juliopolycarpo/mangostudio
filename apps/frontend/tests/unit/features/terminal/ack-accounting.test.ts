import { describe, expect, it } from 'bun:test';
import { createAckAccounting } from '../../../../src/features/terminal/ack-accounting';

/** A controllable clock: `run()` fires every timer whose delay has elapsed. */
class FakeClock {
  private nextId = 1;
  private timers = new Map<number, { readonly ms: number; readonly callback: () => void }>();

  readonly setTimeout = (callback: () => void, ms: number): unknown => {
    const id = this.nextId++;
    this.timers.set(id, { ms, callback });
    return id;
  };

  readonly clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Fires every still-armed timer, as if its delay had elapsed. */
  runPending(): void {
    const due = [...this.timers.entries()];
    for (const [id, timer] of due) {
      if (!this.timers.has(id)) continue; // cleared by an earlier callback in this batch
      this.timers.delete(id);
      timer.callback();
    }
  }

  get armedCount(): number {
    return this.timers.size;
  }
}

describe('createAckAccounting', () => {
  it('does nothing until bytes are added', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    createAckAccounting({
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    expect(flushed).toEqual([]);
    expect(clock.armedCount).toBe(0);
  });

  it('flushes immediately once the byte threshold is crossed', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      flushBytes: 100,
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(40);
    expect(flushed).toEqual([]);
    acks.add(70);

    expect(flushed).toEqual([110]);
    // The threshold flush also clears the timer that was covering the trickle.
    expect(clock.armedCount).toBe(0);
  });

  it('flushes on the timer when bytes trickle in below the threshold', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      flushBytes: 1000,
      flushMs: 50,
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(10);
    acks.add(5);
    expect(flushed).toEqual([]);
    expect(clock.armedCount).toBe(1);

    clock.runPending();

    expect(flushed).toEqual([15]);
  });

  it('starts a fresh accounting window after each flush', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      flushBytes: 100,
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(100);
    acks.add(30);
    clock.runPending();

    expect(flushed).toEqual([100, 30]);
  });

  it('ignores a zero or negative byte count', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(0);
    acks.add(-5);

    expect(flushed).toEqual([]);
    expect(clock.armedCount).toBe(0);
  });

  it('flush() sends pending bytes early and cancels the timer', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      flushBytes: 1000,
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(12);
    acks.flush();

    expect(flushed).toEqual([12]);
    expect(clock.armedCount).toBe(0);
  });

  it('flush() is a no-op when nothing is pending', () => {
    const flushed: number[] = [];
    const acks = createAckAccounting({ onFlush: (bytes) => flushed.push(bytes) });

    acks.flush();

    expect(flushed).toEqual([]);
  });

  it('dispose() cancels the timer and drops pending bytes without flushing', () => {
    const flushed: number[] = [];
    const clock = new FakeClock();
    const acks = createAckAccounting({
      flushBytes: 1000,
      onFlush: (bytes) => flushed.push(bytes),
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
    });

    acks.add(20);
    acks.dispose();
    clock.runPending();

    expect(flushed).toEqual([]);
    expect(clock.armedCount).toBe(0);
  });
});
