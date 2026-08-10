/**
 * An async queue between a vendor's callbacks and a turn's iterator.
 *
 * Notifications arrive on the JSON-RPC pump, which cannot await a consumer, and
 * the adapter interface hands the supervisor an `AsyncIterable`. This is the
 * adaptation and nothing more: push never blocks, pull parks until there is
 * something to yield or the turn is over.
 *
 * `finish` is idempotent and final. A push after it is dropped rather than
 * queued, which is what keeps a late vendor frame from appending to a turn the
 * transcript has already closed.
 */

export class TurnChannel<T> {
  readonly #queue: T[] = [];
  #waiter?: () => void;
  #done = false;

  push(value: T): void {
    if (this.#done) return;
    this.#queue.push(value);
    this.#wake();
  }

  finish(): void {
    this.#done = true;
    this.#wake();
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = undefined;
    waiter?.();
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      // Emptiness is a property of the queue, never of the value at its head: a
      // `T` that is falsy is still something the turn pushed.
      if (this.#queue.length > 0) {
        yield this.#queue.shift() as T;
        continue;
      }
      if (this.#done) return;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }
}
