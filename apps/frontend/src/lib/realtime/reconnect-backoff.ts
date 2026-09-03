/**
 * The timing schedule every browser socket in this app keeps: when it pings,
 * and how long it waits before retrying.
 *
 * Shared rather than copied: the realtime client and the terminal socket had
 * byte-identical constants and delay arithmetic, so tuning one left the other
 * on the old curve with nothing to say so at compile time.
 */

import { REALTIME_IDLE_TIMEOUT_SECONDS } from '@mangostudio/shared/realtime';

/**
 * Ping interval, comfortably inside the idle timeout every hub WebSocket route
 * is mounted with (`REALTIME_WEBSOCKET_OPTIONS`, applied process-wide). Derived
 * from that timeout rather than restated: a hardcoded interval above a lowered
 * timeout is a socket the hub closes on schedule and the client reopens on
 * schedule, forever.
 */
export const SOCKET_HEARTBEAT_MS = Math.floor((REALTIME_IDLE_TIMEOUT_SECONDS * 1_000) / 2.5);

const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
/**
 * Lowest consecutive-failure count whose base delay already saturates the cap.
 * Exported because a caller may want to *start* at the ceiling rather than walk
 * up to it — the realtime client does for a rate-limit close.
 */
export const RECONNECT_MAX_FAILURES = 6;

/**
 * Delay before retry number `failureCount` (1-based), exponential to a cap and
 * then jittered.
 *
 * `random` is injected so a test can assert the schedule instead of sampling it.
 *
 * @example
 * setTimeout(connect, nextReconnectDelay(failureCount, Math.random));
 */
export function nextReconnectDelay(failureCount: number, random: () => number): number {
  const exponent = Math.min(failureCount, RECONNECT_MAX_FAILURES) - 1;
  const base = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** exponent, RECONNECT_MAX_DELAY_MS);
  // Half jitter, never full: a near-zero retry is exactly the case being bounded.
  return base / 2 + random() * (base / 2);
}
