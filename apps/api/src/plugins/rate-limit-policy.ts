/**
 * Rate-limit bucketing policy for the API.
 *
 * The limiter is mounted under the `/api` prefix, so the runtime path it
 * receives is prefixed (e.g. `/api/auth/session`). The matchers below are
 * prefix-tolerant so the policy stays correct whether or not the `/api` prefix
 * is present — this is the bug the earlier `path === '/health'` check missed.
 *
 * Health and auth get their own buckets so they are never starved by — nor able
 * to starve — the general API bucket, while still being capped against floods.
 * Requests carrying `x-api-key` use a separate bucket so automation scripts do
 * not share counters with browser session traffic.
 *
 * `general` is the widest of them, not the strictest. Every narrower bucket
 * bounds one expensive operation; `general` bounds ordinary page loads, and a
 * page load is many requests. Isolation, not a low ceiling, is what keeps a
 * flood in one bucket off the others.
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
  /**
   * Everything without a narrower bucket: the application endpoints a signed-in
   * browser calls, which is to say the cost of ordinary page loads.
   *
   * Sized against the app as it actually loads rather than against one request.
   * A view of the Environments surface — the heaviest — costs ~15 requests in
   * this bucket, so 600 leaves room for roughly 40 page views a minute while
   * still bounding a flood. At the 100 it started with, that was three
   * refreshes: a developer hitting reload while debugging locked themselves out
   * inside a minute (#941).
   *
   * The counter keys on client IP, so — as with `runtimeSocket` and
   * `probeForce` — a ceiling tuned to one browser's cadence would let a single
   * impatient user 429 everyone sharing their address. This is the broadest
   * bucket, covering every ordinary page load, which is where that hurts most.
   */
  general: { name: 'general', max: 600, windowMs: ONE_MINUTE_MS },
  /**
   * Auth endpoints are hit on every page load (session checks) and are a
   * brute-force target. A separate bucket keeps legitimate auth traffic flowing
   * independently of general API load; credential-level lockout is handled by
   * Better Auth.
   *
   * Deliberately left below `general` when that one was widened: a page load
   * costs one session check, not a dozen requests, so this ceiling is already
   * generous against the traffic it sees — and it is the one bucket where a
   * flood is a credential attack rather than an impatient reload.
   */
  auth: { name: 'auth', max: 120, windowMs: ONE_MINUTE_MS },
  /** Liveness probe polled by load balancers/monitoring; generous but bounded. */
  health: { name: 'health', max: 240, windowMs: ONE_MINUTE_MS },
  /**
   * Key-authenticated automation traffic. Counted separately from `general` so a
   * noisy script cannot starve a browser session on the same host IP. Client id
   * is the caller IP until verified key ids can key the bucket (#737).
   *
   * Below `general` and staying there: a script makes the requests it means to,
   * one at a time, so it has no page-load fan-out to pay for. Isolation is what
   * this bucket is for; the ceiling only has to bound a runaway loop.
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
   *
   * Below `general` because a forced scan is the expensive request, but not so
   * far below that the bucket becomes the regression: these routes counted
   * against `general` before they had one, the Environments page offers a
   * re-check per card, and the counter keys on client IP — so, as with
   * `runtimeSocket`, a limit tuned to one operator's cadence would let a
   * single impatient user 429 everyone sharing their address.
   */
  probeForce: { name: 'probe-force', max: 60, windowMs: ONE_MINUTE_MS },
  /**
   * `/api/terminals` — opening, listing, renaming and closing live terminal
   * sessions. Its own bucket so a chat panel driving several of these in a
   * row does not compete with ordinary page-load traffic on `general`.
   */
  terminal: { name: 'terminal', max: 120, windowMs: ONE_MINUTE_MS },
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
  // The pattern is anchored on a literal prefix, so a non-probe path fails on
  // its first characters — a hand-rolled segment pre-check buys nothing here.
  return PROBE_FORCE_PATH_RE.test(withoutTrailingSlash(path));
}

/** Matches `/terminals` and `/terminals/*`, with or without the `/api` prefix. */
export function isTerminalPath(path: string): boolean {
  return matchesSegment(path, '/terminals') || matchesSegment(path, '/api/terminals');
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
  // Exempt here and enforced in the route, on the same bucket. A dialing
  // runtime has no response body to read: an HTTP 429 before the upgrade is a
  // refusal it can only see as a socket that failed to open, so it would back
  // off on the generic curve rather than the longer one this wall deserves.
  // Refusing after the upgrade costs one socket and buys a close code the peer
  // can act on.
  if (isRuntimeSocketPath(path)) return null;
  // Ahead of the forced-probe bucket, not behind it: the api-key bucket exists
  // so a noisy script cannot starve a browser session sharing its IP, and
  // routing key-authenticated probes into the IP-keyed `probe-force` counter
  // would hand automation exactly that lever back.
  if (trimmedApiKeyHeader(headers)) return RATE_LIMIT_BUCKETS.apiKey;
  if (isProbeForcePath(path) && isPostMethod(method)) return RATE_LIMIT_BUCKETS.probeForce;
  if (isTerminalPath(path)) return RATE_LIMIT_BUCKETS.terminal;
  return RATE_LIMIT_BUCKETS.general;
}
