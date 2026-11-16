/**
 * How long the hub's HTTP listener lets a connection sit silent, and the SSE
 * keepalive that has to beat inside that window. `hub-connection-limits.test.ts`
 * pins the relation between the two.
 */

/**
 * Bun.serve closes a connection that carries no bytes for this many seconds,
 * including a request whose handler has not answered yet. 10 is Bun's own
 * default; the hub sets it explicitly so the keepalive below is checked
 * against the value the listener really uses.
 */
export const HUB_IDLE_TIMEOUT_SECONDS = 10;

/**
 * The idle timeout a request gets while its handler runs, set by
 * `plugins/handler-idle-timeout.ts` when the request has no unread body (none
 * was sent, or Elysia has already read it), and put back to
 * `HUB_IDLE_TIMEOUT_SECONDS` as soon as the handler has produced its response.
 * A route that reads the body itself after the hook (`parse: 'none'`) keeps
 * the 10 s while that body is unread.
 *
 * The 10 s listener timeout exists to shed slow clients: one that trickles its
 * headers or body, or stops reading. While a handler is working on a complete
 * request the silence is the hub's own, so Bun resetting it only turns a
 * slow answer into ECONNRESET while the work carries on. 255 s is Bun's maximum
 * rather than "disabled" (0): a handler that never answers on a peer that has
 * vanished still ends, and no route here waits that long for a whole answer.
 *
 * This does not replace the SSE keepalive. A stream's handler returns its
 * `Response` at once, so the timeout is back to 10 s while it streams, and the
 * keepalive still has to beat inside that window (and inside intermediaries'
 * own limits, see below).
 */
export const HUB_HANDLER_IDLE_TIMEOUT_SECONDS = 255;

/**
 * The keepalive interval of every SSE route. It must stay under two limits: the
 * hub's idle timeout above (a 15 s beat let Bun reset install-log and upgrade
 * streams about 12 s into a quiet step), and intermediaries that drop idle
 * connections sooner (the WSL2 localhost relay, issue #994, was measured
 * killing streams 8-11 s into a gap). A comment frame every 5 s costs ~15 bytes.
 */
export const SSE_KEEPALIVE_INTERVAL_MS = 5_000;

/** The SSE comment frame written every `SSE_KEEPALIVE_INTERVAL_MS`. */
export const SSE_KEEPALIVE_FRAME = new TextEncoder().encode(': keepalive\n\n');

/** Bun.serve options for the hub's listener, minus the fetch handler. */
export function hubListenOptions(hostname: string, port: number) {
  // reusePort:false (Elysia defaults it to true) so a port already held by
  // another process raises EADDRINUSE instead of silently load-balancing —
  // this server is single-instance and a collision must fail loudly.
  return { hostname, port, reusePort: false, idleTimeout: HUB_IDLE_TIMEOUT_SECONDS };
}
