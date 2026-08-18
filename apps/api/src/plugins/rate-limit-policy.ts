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
  /**
   * The three `POST .../probe?force` routes deliberately bypass the probing
   * cache, so they get their own bucket rather than leaning on `general` —
   * the probing service's own per-key minimum interval (#690) already caps
   * the scan cost of a stuck re-check button; this bounds the request volume
   * itself, across every id a client can name.
   */
  probeForce: { name: 'probe-force', max: 30, windowMs: ONE_MINUTE_MS },
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

/** The three forced-probe routes, with or without the `/api` prefix. */
const PROBE_FORCE_PATH_RE =
  /^(?:\/api)?\/environments\/(?:runtimes|version-managers|agents)\/[^/]+\/probe$/;

/** Elysia keeps a trailing slash on `ctx.path` when `strictPath` is false. */
function withoutTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Matches `POST .../environments/{runtimes,version-managers,agents}/:id/probe`. */
export function isProbeForcePath(path: string): boolean {
  // classifyRateLimit runs per request, and almost none of them are probes:
  // the cheap segment check keeps the regex off the general hot path.
  const normalized = withoutTrailingSlash(path);
  if (
    !matchesSegment(normalized, '/environments') &&
    !matchesSegment(normalized, '/api/environments')
  ) {
    return false;
  }
  return PROBE_FORCE_PATH_RE.test(normalized);
}

function isPostMethod(method: string | undefined): boolean {
  return method !== undefined && method.toUpperCase() === 'POST';
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
 * Classify a request path (and optional headers and method) into its
 * rate-limit bucket, or `null` for a path that enforces its own.
 *
 * Usage: classifyRateLimit('/api/auth/session') // → RATE_LIMIT_BUCKETS.auth
 */
export function classifyRateLimit(
  path: string,
  headers?: RateLimitHeaderLookup | null,
  method?: string
): RateLimitBucket | null {
  if (isHealthPath(path)) return RATE_LIMIT_BUCKETS.health;
  if (isAuthPath(path)) return RATE_LIMIT_BUCKETS.auth;
  if (isProbeForcePath(path) && isPostMethod(method)) return RATE_LIMIT_BUCKETS.probeForce;
  // Exempt here and enforced in the route, on the same bucket. A dialing
  // runtime has no response body to read: an HTTP 429 before the upgrade is a
  // refusal it can only see as a socket that failed to open, so it would back
  // off on the generic curve rather than the longer one this wall deserves.
  // Refusing after the upgrade costs one socket and buys a close code the peer
  // can act on.
  if (isRuntimeSocketPath(path)) return null;
  if (trimmedApiKeyHeader(headers)) return RATE_LIMIT_BUCKETS.apiKey;
  return RATE_LIMIT_BUCKETS.general;
}
