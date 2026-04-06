/**
 * Basic rate limiting plugin for Elysia.
 * Limits requests per IP address with configurable window and max requests.
 * Uses in-memory storage with LRU eviction (suitable for single-instance deployment).
 */

import { Elysia } from 'elysia';

interface RateLimitConfig {
  /** Maximum number of requests per window (default: 100) */
  max: number;
  /** Time window in milliseconds (default: 60000 = 1 minute) */
  windowMs: number;
  /** Message to return when rate limited (default: 'Too many requests') */
  message: string;
  /** Whether to include rate limit headers (default: true) */
  headers: boolean;
  /** Maximum number of IP entries to keep in memory (default: 10000) */
  maxStoreSize: number;
  /** How often to run lazy cleanup in milliseconds (default: 300000 = 5 minutes) */
  cleanupIntervalMs: number;
  /** Skip rate limiting for certain paths (e.g., health checks) */
  skip?: (path: string) => boolean;
  /** Trust proxy headers (X-Forwarded-For, etc.) for client IP extraction (default: false) */
  trustProxy?: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface RateLimitContext {
  path?: string;
  request: Request;
  set: {
    headers?: Record<string, string>;
    status?: number;
  };
  ip?: string;
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

  // In-memory store: IP key → entry
  const store = new Map<string, RateLimitEntry>();
  let lastCleanup = Date.now();

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

  const plugin = (app: Elysia) => {
    return app
      .derive((context) => {
        const requestContext = context as RateLimitContext;
        // Skip rate limiting for certain paths
        const path = requestContext.path ?? new URL(requestContext.request.url).pathname;
        if (mergedConfig.skip && mergedConfig.skip(path)) {
          return { clientIp: 'skipped' };
        }

        // Extract client IP; only trust proxy headers when explicitly enabled
        let clientIp: string;
        if (mergedConfig.trustProxy) {
          const xForwardedFor = requestContext.request.headers.get('x-forwarded-for');
          clientIp = xForwardedFor
            ? xForwardedFor.split(',')[0].trim()
            : requestContext.request.headers.get('cf-connecting-ip') ||
              requestContext.request.headers.get('x-real-ip') ||
              requestContext.ip ||
              'unknown';
        } else {
          clientIp = requestContext.ip ?? 'unknown';
        }

        return { clientIp };
      })
      .onBeforeHandle((context) => {
        const requestContext = context as RateLimitContext;
        const { clientIp } = requestContext;

        // Skip if no IP or skip function matches
        if (!clientIp || clientIp === 'unknown') {
          return;
        }

        const path = new URL(requestContext.request.url).pathname;
        if (mergedConfig.skip && mergedConfig.skip(path)) {
          return;
        }

        const now = Date.now();

        // Lazy cleanup: run only when the interval has elapsed
        if (now - lastCleanup >= mergedConfig.cleanupIntervalMs) {
          cleanup();
        }

        const key = `rate-limit:${clientIp}`;
        const existing = store.get(key);

        // Initialize or reset expired entry; capture in `entry` to avoid a second Map lookup
        let entry: RateLimitEntry;
        if (!existing || existing.resetTime < now) {
          entry = { count: 1, resetTime: now + mergedConfig.windowMs };
          store.set(key, entry);
        } else {
          existing.count++;
          entry = existing;
        }

        // Set rate limit headers
        if (mergedConfig.headers) {
          const remaining = Math.max(0, mergedConfig.max - entry.count);
          requestContext.set.headers ??= {};
          requestContext.set.headers['X-RateLimit-Limit'] = mergedConfig.max.toString();
          requestContext.set.headers['X-RateLimit-Remaining'] = remaining.toString();
          requestContext.set.headers['X-RateLimit-Reset'] = Math.ceil(
            entry.resetTime / 1000
          ).toString();
        }

        // Check if rate limited
        if (entry.count > mergedConfig.max) {
          requestContext.set.status = 429;
          throw new Error(mergedConfig.message);
        }
      });
  };

  return Object.assign(plugin, { teardown });
}
