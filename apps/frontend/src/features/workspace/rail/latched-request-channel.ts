/**
 * A one-shot latched request channel, for asking a rail panel to do something
 * from outside its own component tree.
 *
 * The problem it solves: a caller like the command palette pairs a request with
 * `requestRailPanel(id)`, whose state update has not committed yet when the
 * request fires, so the panel is not subscribed until the next render. The latch
 * covers that gap — a request with no listener mounted is held and replayed to
 * the first listener that subscribes, then cleared. A request made while a
 * listener *is* mounted is delivered directly and never latched, so a later
 * remount cannot replay a stale one.
 *
 * `rail-panel-request` is the un-latched, keyed sibling: it addresses panels by
 * id and drops a request nobody is listening for.
 *
 * @example
 * const { request, subscribe } = createLatchedRequestChannel();
 * export const requestThing = request;
 * export const onThingRequest = subscribe;
 */
export interface LatchedRequestChannel {
  /** Fires every mounted listener, or latches the request if there are none. */
  request(): void;
  /** Subscribes, replaying a latched request once; returns an unsubscribe. */
  subscribe(listener: () => void): () => void;
}

export function createLatchedRequestChannel(): LatchedRequestChannel {
  const listeners = new Set<() => void>();
  let pending = false;

  return {
    request() {
      if (listeners.size === 0) {
        pending = true;
        return;
      }
      for (const listener of listeners) listener();
    },

    subscribe(listener) {
      listeners.add(listener);
      if (pending) {
        pending = false;
        listener();
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
