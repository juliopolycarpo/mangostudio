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
 * capped against floods. Requests carrying `x-api-key` use a separate bucket so
 * automation scripts do not share counters with browser session traffic.
 *
 * The api-key bucket is keyed by client IP for now. Hashing the raw header for
 * a per-key counter would let an unauthenticated caller rotate `x-api-key` and
 * escape both buckets; verified Better Auth key ids arrive only after
 * `apiKeyGuard`, which runs after this limiter (see issue #737).
 */

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import type { RateLimitBucket } from './rate-limit-types';

const ONE_MINUTE_MS = 60_000;

/** Minimal header lookup for classification without touching the request body. */
export type RateLimitHeaderLookup = {
  get(name: string): string | null | undefined;
};

/** Per-route-group limits. Each bucket has an independent per-client counter. */
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
  /**
   * Key-authenticated automation traffic. Counted separately from `general` so a
   * noisy script cannot starve a browser session on the same host IP. Client id
   * is the caller IP until verified key ids can key the bucket (#737).
   */
  apiKey: { name: 'api-key', max: 120, windowMs: ONE_MINUTE_MS },
  /**
   * Runtime dial-in upgrades. Sized well above the documented reconnect
   * cadence on purpose: buckets key on client IP, so a bucket tuned to one
   * runtime's backoff would let a single revoked-token runtime behind a NAT
   * 429 every healthy runtime sharing its address.
   */
  runtimeSocket: { name: 'runtime-socket', max: 60, windowMs: ONE_MINUTE_MS },
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

/** Matches the runtime dial-in endpoint and its `/api`-prefixed form. */
export function isRuntimeSocketPath(path: string): boolean {
  return path === '/runtime' || path === '/api/runtime';
}

function trimmedApiKeyHeader(headers: RateLimitHeaderLookup | null | undefined): string | null {
  const raw = headers?.get(API_KEY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Resolve the counter key for a bucket. All buckets use `clientIp` today; the
 * api-key bucket still classifies separately so automation does not share the
 * general counter. Per-key client ids need a verified key id (#737).
 */
export function resolveRateLimitClientId(
  _bucket: RateLimitBucket,
  _headers: RateLimitHeaderLookup | null | undefined,
  clientIp: string
): string {
  return clientIp;
}

/**
 * Classify a request path (and optional headers) into its rate-limit bucket.
 *
 * Usage: classifyRateLimit('/api/auth/session') // → RATE_LIMIT_BUCKETS.auth
 */
export function classifyRateLimit(
  path: string,
  headers?: RateLimitHeaderLookup | null
): RateLimitBucket {
  if (isHealthPath(path)) return RATE_LIMIT_BUCKETS.health;
  if (isAuthPath(path)) return RATE_LIMIT_BUCKETS.auth;
  if (isRuntimeSocketPath(path)) return RATE_LIMIT_BUCKETS.runtimeSocket;
  if (trimmedApiKeyHeader(headers)) return RATE_LIMIT_BUCKETS.apiKey;
  return RATE_LIMIT_BUCKETS.general;
}
