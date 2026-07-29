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
 */

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { computeHash } from '../utils/hash';
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
   * noisy script cannot starve a browser session on the same host IP.
   */
  apiKey: { name: 'api-key', max: 120, windowMs: ONE_MINUTE_MS },
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

function trimmedApiKeyHeader(headers: RateLimitHeaderLookup | null | undefined): string | null {
  const raw = headers?.get(API_KEY_HEADER);
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Stable store id for an API key header value. The raw secret is never stored;
 * this is a truncated SHA-256 digest, not the Better Auth key id (that id is
 * unavailable before `apiKeyGuard` runs).
 */
function hashApiKeyHeader(value: string): string {
  return `key:${computeHash(value).slice(0, 32)}`;
}

/**
 * Resolve the counter key for a bucket. IP buckets use `clientIp`; the api-key
 * bucket uses a hash of `x-api-key` when present, otherwise falls back to IP.
 */
export function resolveRateLimitClientId(
  bucket: RateLimitBucket,
  headers: RateLimitHeaderLookup | null | undefined,
  clientIp: string
): string {
  if (bucket.name !== RATE_LIMIT_BUCKETS.apiKey.name) {
    return clientIp;
  }
  const apiKey = trimmedApiKeyHeader(headers);
  return apiKey ? hashApiKeyHeader(apiKey) : clientIp;
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
  if (trimmedApiKeyHeader(headers)) return RATE_LIMIT_BUCKETS.apiKey;
  return RATE_LIMIT_BUCKETS.general;
}
