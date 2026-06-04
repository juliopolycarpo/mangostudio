/**
 * Rate-limit bucketing policy for the API.
 *
 * The limiter is mounted under the `/api` prefix, so the runtime path it
 * receives is prefixed (e.g. `/api/auth/session`). The matchers below are
 * prefix-tolerant so the policy stays correct whether or not the `/api` prefix
 * is present — this is the bug the earlier `path === '/health'` check missed.
 *
 * Health and auth get their own, more generous buckets so they are never
 * starved by — nor able to starve — the general API bucket, while still being
 * capped against floods.
 */

import type { RateLimitBucket } from './rate-limit';

const ONE_MINUTE_MS = 60_000;

/** Per-route-group limits. Each bucket has an independent per-IP counter. */
export const RATE_LIMIT_BUCKETS = {
  /** Expensive application and generation endpoints (the baseline limit). */
  general: { name: 'general', max: 100, windowMs: ONE_MINUTE_MS },
  /**
   * Auth endpoints are hit on every page load (session checks) and are a
   * brute-force target. A separate, more generous bucket keeps legitimate auth
   * traffic flowing independently of general API load; credential-level lockout
   * is handled by Better Auth.
   */
  auth: { name: 'auth', max: 120, windowMs: ONE_MINUTE_MS },
  /** Liveness probe polled by load balancers/monitoring; generous but bounded. */
  health: { name: 'health', max: 240, windowMs: ONE_MINUTE_MS },
} as const satisfies Record<string, RateLimitBucket>;

/** True when `path` equals `base` or sits directly under it (`base/...`). */
function matchesSegment(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/** Matches `/health` and `/api/health` (prefix-tolerant). */
export function isHealthPath(path: string): boolean {
  return matchesSegment(path, '/health') || matchesSegment(path, '/api/health');
}

/** Matches `/auth`, `/auth/*` and their `/api`-prefixed forms. */
export function isAuthPath(path: string): boolean {
  return matchesSegment(path, '/auth') || matchesSegment(path, '/api/auth');
}

/**
 * Classify a request path into its rate-limit bucket.
 *
 * Usage: classifyRateLimit('/api/auth/session') // → RATE_LIMIT_BUCKETS.auth
 */
export function classifyRateLimit(path: string): RateLimitBucket {
  if (isHealthPath(path)) return RATE_LIMIT_BUCKETS.health;
  if (isAuthPath(path)) return RATE_LIMIT_BUCKETS.auth;
  return RATE_LIMIT_BUCKETS.general;
}
