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
