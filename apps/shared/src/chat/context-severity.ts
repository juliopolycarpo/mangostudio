/**
 * The band a context-window ratio falls in.
 *
 * Shared rather than owned by the hub's context policy because two surfaces
 * colour from it: the hub, which persists a severity beside every snapshot it
 * estimates, and the composer, which colours an external agent's context ring
 * from a ratio the hub never sees. One set of thresholds, one place to move
 * them.
 */

/** Threshold category for UI display. */
export type ContextSeverity = 'normal' | 'info' | 'warning' | 'danger' | 'critical';

/**
 * Product defaults:
 *   0-69%   → normal   (continue as-is)
 *   70-84%  → info     (continue, maybe log)
 *   85-91%  → warning  (continue but warn)
 *   92-96%  → danger   (consider compaction)
 *   97%+    → critical (stop or compact)
 */
export function getContextSeverity(ratio: number): ContextSeverity {
  if (ratio < 0.7) return 'normal';
  if (ratio < 0.85) return 'info';
  if (ratio < 0.92) return 'warning';
  if (ratio < 0.97) return 'danger';
  return 'critical';
}
