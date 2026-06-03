/**
 * Basic rate limiting plugin for Elysia.
 * Counts requests per (bucket, client IP) with a configurable window and max.
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

/** A named limit bucket: requests are counted per (bucket, client IP). */
export interface RateLimitBucket {
  /** Identifier used to namespace the per-IP counter store. */
  name: string;
  /** Maximum number of requests allowed per window. */
  max: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

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
  classify?: (path: string) => RateLimitBucket | null;
  /** Trust proxy headers (X-Forwarded-For, etc.) for client IP (default: false) */
  trustProxy?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
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
function resolvePath(path: string | undefined, url: string): string {
  return path ?? new URL(url).pathname;
}

/**
 * Extract the client IP, honoring proxy headers only when explicitly trusted.
 * `ip` is the peer socket address (the unspoofable default); proxy headers
 * override it only when `trustProxy` is set.
 *
 * Takes `headers` and `ip` as discrete arguments rather than the request or the
 * whole Elysia context on purpose. Elysia statically analyzes hook source to
 * decide what to materialize: handing a hook the full context (or the bare
 * `request`) makes it treat the body as "maybe used" and eagerly parse it,
 * which consumes the stream before the Better Auth passthrough can read it
 * (`ERR_BODY_ALREADY_USED`) — and also drops the `set` mutations made later in
 * the request. Referencing only the `headers` sub-object sidesteps both.
 */
function extractClientIp(headers: Headers, ip: string | undefined, trustProxy: boolean): string {
  if (!trustProxy) return ip ?? 'unknown';

  const forwarded = headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();

  return headers.get('cf-connecting-ip') || headers.get('x-real-ip') || ip || 'unknown';
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

  // In-memory store: `rate-limit:<bucket>:<ip>` key → entry
  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

  // Single bucket used when the caller does not supply a `classify` function.
  const defaultBucket: RateLimitBucket = {
    name: 'global',
    max: mergedConfig.max,
    windowMs: mergedConfig.windowMs,
  };

  /** Resolve the bucket for a path, or `null` when the path is exempt. */
  function resolveBucket(path: string): RateLimitBucket | null {
    return mergedConfig.classify ? mergedConfig.classify(path) : defaultBucket;
  }

  /** Remove expired entries; evict oldest when store exceeds maxStoreSize. */
  function cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetTime < now) {
        store.delete(key);
      }
    }
    // If still over limit after expiry cleanup, evict oldest entries
    if (store.size > mergedConfig.maxStoreSize) {
      const overflow = store.size - mergedConfig.maxStoreSize;
      let evicted = 0;
      for (const key of store.keys()) {
        store.delete(key);
        evicted++;
        if (evicted >= overflow) break;
      }
    }
    lastCleanup = now;
  }

  /** Call in tests or on graceful shutdown to free resources. */
  function teardown(): void {
    store.clear();
  }

  /** Increment (or initialize/reset) the counter for a bucket+IP key. */
  function touch(key: string, bucket: RateLimitBucket, now: number): RateLimitEntry {
    const existing = store.get(key);
    if (!existing || existing.resetTime < now) {
      const entry: RateLimitEntry = { count: 1, resetTime: now + bucket.windowMs };
      store.set(key, entry);
      return entry;
    }
    existing.count++;
    return existing;
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
      .onBeforeHandle((context) => {
        const ctx = context as RateLimitContext;
        const { clientIp } = ctx;

        // Cannot identify the caller → cannot fairly rate limit.
        if (!clientIp || clientIp === 'unknown') {
          return;
        }

        const bucket = resolveBucket(resolvePath(ctx.path, ctx.request.url));
        if (!bucket) {
          return; // path is exempt
        }

        const now = Date.now();

        // Lazy cleanup: run only when the interval has elapsed
        if (now - lastCleanup >= mergedConfig.cleanupIntervalMs) {
          cleanup();
        }

        const entry = touch(`rate-limit:${bucket.name}:${clientIp}`, bucket, now);
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
