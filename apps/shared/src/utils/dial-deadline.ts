/**
 * A deadline for a dial that neither opens nor fails.
 *
 * A WebSocket dial settles on `open`, on `error` or on `close`; a host that
 * accepts the TCP connection and then says nothing produces none of the three.
 * The runtime connection manager leaves that bound to the connector — "a
 * connector that only spawns a process is bounded by its own handshake timeout"
 * — so a dialling connector has to carry one of its own. The runtime's own
 * reconnect loop dials the hub and needs the same bound, which is why this
 * lives in shared rather than beside either caller.
 */

export interface DialDeadline {
  /** Aborts once the deadline passes; `reason` is the error the dial rejects with. */
  readonly signal: AbortSignal;
  /** Cancels the deadline. Safe to call after it already fired. */
  clear(): void;
}

/**
 * Starts a deadline that aborts with `message` after `timeoutMs`.
 *
 * The timer is unreferenced, so an armed deadline never keeps a process alive
 * on its own.
 *
 * @example
 * const deadline = dialDeadline(15_000, 'The runtime did not answer.');
 * try {
 *   return await connectWebSocket(url, { signal: deadline.signal });
 * } finally {
 *   deadline.clear();
 * }
 */
export function dialDeadline(timeoutMs: number, message: string): DialDeadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(message)), timeoutMs);
  (timer as { unref?: () => void }).unref?.();
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  };
}
