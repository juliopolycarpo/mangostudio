/**
 * Tracks how recently this tab wrote app settings, so the realtime bridge can
 * tell an external change from this tab's own echo.
 *
 * The server publishes a `settings` invalidation after every successful write,
 * ours included. Auto-save is debounced, so that echo routinely lands while the
 * user is still editing the same control — refetching then would overwrite what
 * they are typing with the value they typed a moment earlier.
 *
 * The window is a bare timestamp rather than an in-flight counter on purpose: a
 * counter that misses a decrement (an unmount mid-flight, a rejected mutation
 * that skips its handler) would suppress invalidations for the rest of the
 * session, which turns an optimization into a page that silently stops
 * updating. A timestamp always heals on its own.
 */

/**
 * Covers the auto-save debounce plus a local round-trip. A slower request is
 * fine: the write path re-marks the window when the request settles, and an
 * echo that slips through carries the value we just stored anyway.
 */
const LOCAL_WRITE_WINDOW_MS = 2_000;

let lastLocalWriteAtMs = Number.NEGATIVE_INFINITY;

/** Call on every local edit, and again when its request settles. */
export function markAppSettingsLocalWrite(): void {
  lastLocalWriteAtMs = Date.now();
}

export function hasRecentAppSettingsLocalWrite(): boolean {
  return Date.now() - lastLocalWriteAtMs < LOCAL_WRITE_WINDOW_MS;
}

/** Test hook: the window is module state and outlives a single render tree. */
export function resetAppSettingsLocalWriteWindow(): void {
  lastLocalWriteAtMs = Number.NEGATIVE_INFINITY;
}
