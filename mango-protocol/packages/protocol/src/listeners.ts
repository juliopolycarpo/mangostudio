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

  clear(): void {
    this.#set.clear();
  }

  get size(): number {
    return this.#set.size;
  }
}
