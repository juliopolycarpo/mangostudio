/**
 * A small listener registry shared by ports and the session: add returns the
 * matching remove, and emit snapshots the set so a listener may unsubscribe
 * itself (or close the owner) while being called.
 *
 * @example
 * const listeners = new Listeners<string>();
 * const off = listeners.add((value) => console.warn(value));
 * listeners.emit('hello');
 * off();
 */
export class Listeners<T> {
  readonly #set = new Set<(value: T) => void>();

  add(listener: (value: T) => void): () => void {
    this.#set.add(listener);
    return () => {
      this.#set.delete(listener);
    };
  }

  emit(value: T): void {
    for (const listener of [...this.#set]) listener(value);
  }

  /**
   * Notifies all observers before rethrowing the first failure.
   * @example closureListeners.emitAll(closure);
   */
  emitAll(value: T): void {
    let failure: Error | undefined;
    for (const listener of [...this.#set]) {
      try {
        listener(value);
      } catch (error) {
        failure ??=
          error instanceof Error
            ? error
            : new Error('Listener threw a non-Error value', { cause: error });
      }
    }
    if (failure) throw failure;
  }

  clear(): void {
    this.#set.clear();
  }

  get size(): number {
    return this.#set.size;
  }
}
