/**
 * Turns a callback-based producer — a function that calls `emit` some number
 * of times before resolving with a final result — into an async generator of
 * the emitted items, with the settled result readable once iteration ends.
 *
 * The producer starts immediately (not on first pull): items it emits before
 * anything has consumed the generator are queued, not dropped. Two unrelated
 * producers use this today — `run-script.ts` merges a process's stdout and
 * stderr lines in arrival order, and `machine-service.ts`'s upgrade route
 * turns the upgrade engine's `emit` callback into the SSE stream's source —
 * and both want the exact same queue-and-wake mechanics, not two copies of it.
 */

export interface EmitBridge<T, R> {
  readonly items: AsyncGenerator<T>;
  /** The producer's settled result, or undefined before `items` has finished. */
  result(): R | undefined;
  /**
   * Resolves with the producer's result whenever it settles, independent of
   * whether anything is still consuming `items`. A consumer that stops
   * draining `items` early (e.g. an SSE client disconnecting) can await this
   * to react to the producer's outcome instead of missing it.
   */
  readonly settled: Promise<R>;
}

/** // Usage: bridgeEmitter((emit) => runSomething(emit)) */
export function bridgeEmitter<T, R>(
  produce: (emit: (item: T) => void) => Promise<R>
): EmitBridge<T, R> {
  const queue: T[] = [];
  let wake: (() => void) | null = null;
  const emit = (item: T): void => {
    queue.push(item);
    wake?.();
    wake = null;
  };

  let done = false;
  let result: R | undefined;
  const wakeConsumer = (): void => {
    done = true;
    wake?.();
    wake = null;
  };
  // Both branches wake the consumer: a rejection that only resolved the
  // success handler would leave `items()` waiting on a `wake` nothing ever
  // calls, forever, instead of reaching `await running` to rethrow it.
  const running = produce(emit).then(
    (value) => {
      result = value;
      wakeConsumer();
      return value;
    },
    (error: unknown) => {
      wakeConsumer();
      throw error;
    }
  );

  async function* items(): AsyncGenerator<T> {
    for (;;) {
      if (queue.length > 0) {
        // biome-ignore lint/style/noNonNullAssertion: length just checked under single-threaded JS; nothing else drains this queue between the check and the shift.
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    await running;
  }

  return { items: items(), result: () => result, settled: running };
}
