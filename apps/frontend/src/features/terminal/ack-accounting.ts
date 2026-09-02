/**
 * Coalesces terminal output acks so a fast-scrolling process does not send one
 * `{type: 'ack'}` frame per `term.write` callback.
 *
 * The server measures `TERMINAL_INFLIGHT_WINDOW_BYTES` against unacknowledged
 * bytes, so an ack has to travel eventually — but flushing on every write would
 * be one socket send per PTY chunk. This batches by size (a burst of output
 * flushes as soon as it crosses the threshold) and by time (a trickle of
 * output still acks within a bounded delay), whichever comes first.
 *
 * Pure: the timer functions are injected so a test can drive it without real
 * time passing.
 *
 * @example
 * const acks = createAckAccounting({ onFlush: (bytes) => socket.ack(bytes) });
 * acks.add(chunk.byteLength); // after term.write(chunk, cb) calls back
 */

const DEFAULT_FLUSH_BYTES = 4 * 1024;
const DEFAULT_FLUSH_MS = 50;

export interface AckAccountingOptions {
  /** Bytes accumulated before a flush fires early. Default 4 KiB. */
  readonly flushBytes?: number;
  /** Longest an ack may wait once bytes are pending. Default 50 ms. */
  readonly flushMs?: number;
  /** Called with the bytes accumulated since the previous flush. */
  readonly onFlush: (bytes: number) => void;
  /**
   * Timer handle is deliberately `unknown`: Bun's global `setTimeout` and the
   * DOM lib's disagree on their return type (`Timer` vs `number`), and this
   * module never inspects the handle — only ever hands it back to whichever
   * `clearTimeout` scheduled it.
   */
  readonly setTimeout?: (callback: () => void, ms: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
}

export interface AckAccounting {
  /** Records bytes written to the terminal since the previous flush. */
  add(bytes: number): void;
  /** Sends whatever is pending right now, if anything is. */
  flush(): void;
  /** Cancels a pending timer without flushing; nothing further is sent. */
  dispose(): void;
}

export function createAckAccounting(options: AckAccountingOptions): AckAccounting {
  const flushBytes = options.flushBytes ?? DEFAULT_FLUSH_BYTES;
  const flushMs = options.flushMs ?? DEFAULT_FLUSH_MS;
  const schedule: (callback: () => void, ms: number) => unknown =
    options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
  const unschedule: (handle: unknown) => void =
    options.clearTimeout ??
    ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));

  let pending = 0;
  let timer: unknown;

  function clearTimer(): void {
    if (timer === undefined) return;
    unschedule(timer);
    timer = undefined;
  }

  function flush(): void {
    clearTimer();
    if (pending === 0) return;
    const bytes = pending;
    pending = 0;
    options.onFlush(bytes);
  }

  function add(bytes: number): void {
    if (bytes <= 0) return;
    pending += bytes;
    if (pending >= flushBytes) {
      flush();
      return;
    }
    if (timer === undefined) timer = schedule(flush, flushMs);
  }

  function dispose(): void {
    clearTimer();
    pending = 0;
  }

  return { add, flush, dispose };
}
