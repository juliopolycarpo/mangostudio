/**
 * Basic rate limiting plugin for Elysia.
 * Counts requests per (bucket, client id) with a configurable window and max.
 * Client id is the caller IP for every bucket today; the api-key bucket still
 * classifies separately so automation does not share the general counter.
 * An injected `classify` function sorts each request path into a named bucket,
 * letting route groups (e.g. health, auth, general API) carry independent
 * limits without sharing a counter.
 *
 * NOTE: This implementation uses process-local in-memory storage. It will NOT
 * correctly enforce rate limits across multiple processes or instances (e.g.,
 * in a load-balanced deployment). For multi-process deployments, replace the
 * `store` Map with a shared backend such as Redis.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import { resolveRateLimitClientId } from './rate-limit-policy';
import { type RateLimitEntry, RateLimitStore } from './rate-limit-store';
import type { RateLimitBucket } from './rate-limit-types';

export type { RateLimitBucket } from './rate-limit-types';

interface RateLimitConfig {
  /** Max requests for the default bucket when `classify` is not provided. */
  max: number;
  /** Window for the default bucket when `classify` is not provided. */
  windowMs: number;
  /** Message returned in the 429 body (default: 'Too many requests…') */
  message: string;
  /** Whether to include rate limit headers (default: true) */
  headers: boolean;
  /** Maximum number of counter entries to keep in memory (default: 10000) */
  maxStoreSize: number;
  /** How often to run lazy cleanup in milliseconds (default: 300000 = 5 min) */
  cleanupIntervalMs: number;
  /**
   * Resolve which bucket applies to a request path. Return `null` to exempt the
   * path from rate limiting entirely. Defaults to a single 'global' bucket
   * built from `max`/`windowMs`.
   */
  classify?: (path: string, headers?: Headers, method?: string) => RateLimitBucket | null;
  /** Trust proxy headers (X-Forwarded-For, etc.) for client IP (default: false) */
  trustProxy?: boolean;
}

/** Mutable response controls Elysia exposes on the context. */
interface RateLimitSet {
  headers?: Record<string, string>;
  status?: number;
}

/** Minimal slice of the Bun server needed to resolve the peer socket address. */
interface RateLimitServer {
  requestIP(request: Request): { address: string } | null;
}

interface RateLimitContext {
  path?: string;
  request: Request;
  set: RateLimitSet;
  // Elysia never populates `ctx.ip`; the peer address comes from `server`.
  server?: RateLimitServer | null;
  clientIp?: string;
}

const defaultConfig: RateLimitConfig = {
  max: 100,
  windowMs: 60000, // 1 minute
  message: 'Too many requests, please try again later.',
  headers: true,
  maxStoreSize: 10000,
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
};

/** Resolve the request path, preferring Elysia's parsed `path`. */
export function resolvePath(path: string | undefined, url: string): string {
  return path ?? new URL(url).pathname;
}

/** Upper bound on a plausible IP token (IPv6 + zone id ≈ 50 chars); reject longer. */
const MAX_CLIENT_IP_LENGTH = 64;

/**
 * Trimmed IP candidate, or null when it is empty or implausibly long. Bounds the
 * store-key size so a hostile forwarded header cannot push megabyte-long keys
 * into memory. // Usage: sanitizeClientIp(' 1.2.3.4 ') // → "1.2.3.4"
 */
function sanitizeClientIp(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_CLIENT_IP_LENGTH) return null;
  return trimmed;
}

/**
 * Extract the client IP, honoring proxy headers only when explicitly trusted.
 * `ip` is the peer socket address (the unspoofable default); proxy headers
 * override it only when `trustProxy` is set. Every source is run through
 * `sanitizeClientIp`, so a blank leading X-Forwarded-For hop (e.g. ",9.9.9.9")
 * or an oversized value falls through to the next source instead of yielding an
 * empty/huge key that would bypass or bloat the limiter.
 *
 * Takes `headers` and `ip` as discrete arguments rather than the request or the
 * whole Elysia context on purpose. Elysia statically analyzes hook source to
 * decide what to materialize: handing a hook the full context (or the bare
 * `request`) makes it treat the body as "maybe used" and eagerly parse it,
 * which consumes the stream before the Better Auth passthrough can read it
 * (`ERR_BODY_ALREADY_USED`) — and also drops the `set` mutations made later in
 * the request. Referencing only the `headers` sub-object sidesteps both.
 */
export function extractClientIp(
  headers: Headers,
  ip: string | undefined,
  trustProxy: boolean
): string {
  if (!trustProxy) return sanitizeClientIp(ip) ?? 'unknown';

  const forwarded = sanitizeClientIp(headers.get('x-forwarded-for')?.split(',')[0]);
  if (forwarded) return forwarded;

  const proxyIp =
    sanitizeClientIp(headers.get('cf-connecting-ip')) ?? sanitizeClientIp(headers.get('x-real-ip'));
  return proxyIp ?? sanitizeClientIp(ip) ?? 'unknown';
}

/**
 * Creates a rate limiting plugin for Elysia.
 * Cleanup runs lazily on requests instead of via setInterval to avoid
 * dangling timers that prevent process exit or leak memory in tests.
 *
 * @param config - Configuration options
 * @returns Elysia plugin with an optional `teardown()` export for tests
 */
export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const mergedConfig: RateLimitConfig = { ...defaultConfig, ...config };

  // In-memory store, keyed `rate-limit:<bucket>:<ip>`, bounded by maxStoreSize.
  const store = new RateLimitStore(mergedConfig.maxStoreSize);
  let lastCleanup = Date.now();

  // Single bucket used when the caller does not supply a `classify` function.
  const defaultBucket: RateLimitBucket = {
    name: 'global',
    max: mergedConfig.max,
    windowMs: mergedConfig.windowMs,
  };

  /** Resolve the bucket for a path, or `null` when the path is exempt. */
  function resolveBucket(path: string, headers: Headers, method: string): RateLimitBucket | null {
    return mergedConfig.classify ? mergedConfig.classify(path, headers, method) : defaultBucket;
  }

  /** Periodic expiry sweep; overflow eviction runs per-request via the store. */
  function runScheduledCleanup(now: number): void {
    store.removeExpired(now);
    lastCleanup = now;
  }

  /** Call in tests or on graceful shutdown to free resources. */
  function teardown(): void {
    store.clear();
  }

  /** Set X-RateLimit-* headers reflecting the current bucket state. */
  function setRateHeaders(set: RateLimitSet, bucket: RateLimitBucket, entry: RateLimitEntry): void {
    if (!mergedConfig.headers) return;
    const remaining = Math.max(0, bucket.max - entry.count);
    set.headers ??= {};
    set.headers['X-RateLimit-Limit'] = bucket.max.toString();
    set.headers['X-RateLimit-Remaining'] = remaining.toString();
    set.headers['X-RateLimit-Reset'] = Math.ceil(entry.resetTime / 1000).toString();
  }

  /** Build the 429 response, setting status and a Retry-After header. */
  function rejectOverLimit(
    set: RateLimitSet,
    entry: RateLimitEntry,
    now: number
  ): ApiErrorResponse {
    set.status = 429;
    set.headers ??= {};
    set.headers['Retry-After'] = Math.max(1, Math.ceil((entry.resetTime - now) / 1000)).toString();
    return { error: mergedConfig.message, code: ERROR_CODES.RATE_LIMITED };
  }

  const plugin = (app: Elysia) => {
    return app
      .derive((context) => {
        const ctx = context as RateLimitContext;
        // Elysia leaves `ctx.ip` unset, so derive the peer address from the
        // server socket — otherwise every caller collapses to 'unknown' and the
        // limiter never enforces. `trustProxy` still gates header overrides.
        // Pass `headers`, not `ctx`/`request`: see extractClientIp.
        const socketIp = ctx.server?.requestIP(ctx.request)?.address;
        const clientIp = extractClientIp(
          ctx.request.headers,
          socketIp,
          mergedConfig.trustProxy ?? false
        );
        return { clientIp };
      })
      .beforeHandle((context) => {
        const ctx = context as RateLimitContext;
        const { clientIp } = ctx;

        // Cannot identify the caller → cannot fairly rate limit.
        if (!clientIp || clientIp === 'unknown') {
          return;
        }

        const headers = ctx.request.headers;
        const bucket = resolveBucket(
          resolvePath(ctx.path, ctx.request.url),
          headers,
          ctx.request.method
        );
        if (!bucket) {
          return; // path is exempt
        }

        const clientId = resolveRateLimitClientId(bucket, headers, clientIp);
        const now = Date.now();

        // Lazy expiry sweep: run only when the interval has elapsed.
        if (now - lastCleanup >= mergedConfig.cleanupIntervalMs) {
          runScheduledCleanup(now);
        }

        const entry = store.touch(`rate-limit:${bucket.name}:${clientId}`, bucket.windowMs, now);
        // Bound memory immediately (not just on the timer) so a flood of distinct
        // keys — e.g. spoofed forwarded IPs — cannot grow the store unbounded.
        store.evictOverflow();
        // Pass `ctx.set`, not `ctx`: aliasing the whole context here would make
        // Elysia eagerly parse the request body. See extractClientIp.
        setRateHeaders(ctx.set, bucket, entry);

        if (entry.count > bucket.max) {
          return rejectOverLimit(ctx.set, entry, now);
        }
      });
  };

  return Object.assign(plugin, { teardown });
}
