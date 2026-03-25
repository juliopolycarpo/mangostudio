/**
 * Basic rate limiting plugin for Elysia.
 * Limits requests per IP address with configurable window and max requests.
 * Uses in-memory storage (suitable for single-instance deployment).
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
  /** Skip rate limiting for certain paths (e.g., health checks) */
  skip?: (path: string) => boolean;
}

interface RateLimitStore {
  [key: string]: {
    count: number;
    resetTime: number;
  };
}

const defaultConfig: RateLimitConfig = {
  max: 100,
  windowMs: 60000, // 1 minute
  message: 'Too many requests, please try again later.',
  headers: true,
};

/**
 * Creates a rate limiting plugin for Elysia.
 *
 * @param config - Configuration options
 * @returns Elysia plugin
 */
export function rateLimit(config: Partial<RateLimitConfig> = {}) {
  const mergedConfig: RateLimitConfig = { ...defaultConfig, ...config };

  // In-memory store (cleaned periodically)
  const store: RateLimitStore = {};

  // Clean up old entries periodically (every 5 minutes)
  const cleanupInterval = setInterval(
    () => {
      const now = Date.now();
      for (const key in store) {
        if (store[key].resetTime < now) {
          delete store[key];
        }
      }
    },
    5 * 60 * 1000
  );

  // Clean up interval on process exit (if possible)
  if (typeof process !== 'undefined') {
    process.on('SIGINT', () => clearInterval(cleanupInterval));
    process.on('SIGTERM', () => clearInterval(cleanupInterval));
  }

  return (app: Elysia) => {
    return app
      .derive((context: any) => {
        // Skip rate limiting for certain paths
        const path = context.path || new URL(context.request.url).pathname;
        if (mergedConfig.skip && mergedConfig.skip(path)) {
          return { clientIp: 'skipped' };
        }

        // Get client IP (prioritize X-Forwarded-For header for proxy support)
        const xForwardedFor = context.request.headers.get('x-forwarded-for');
        const clientIp = xForwardedFor
          ? xForwardedFor.split(',')[0].trim()
          : context.request.headers.get('cf-connecting-ip') ||
            context.request.headers.get('x-real-ip') ||
            (context as any).ip ||
            'unknown';

        return { clientIp };
      })
      .onRequest((context) => {
        const { clientIp } = context as any;

        // Skip if no IP or skip function matches
        if (!clientIp || clientIp === 'unknown') {
          return;
        }

        const path = new URL(context.request.url).pathname;
        if (mergedConfig.skip && mergedConfig.skip(path)) {
          return;
        }

        const now = Date.now();
        const key = `rate-limit:${clientIp}`;

        // Initialize or get existing entry
        if (!store[key] || store[key].resetTime < now) {
          store[key] = {
            count: 0,
            resetTime: now + mergedConfig.windowMs,
          };
        }

        // Increment counter
        store[key].count++;

        // Set rate limit headers
        if (mergedConfig.headers) {
          const remaining = Math.max(0, mergedConfig.max - store[key].count);
          const resetTime = store[key].resetTime;

          if (!context.set.headers) context.set.headers = {};
          context.set.headers['X-RateLimit-Limit'] = mergedConfig.max.toString();
          context.set.headers['X-RateLimit-Remaining'] = remaining.toString();
          context.set.headers['X-RateLimit-Reset'] = Math.ceil(resetTime / 1000).toString();
        }

        // Check if rate limited
        if (store[key].count > mergedConfig.max) {
          context.set.status = 429;
          throw new Error(mergedConfig.message);
        }
      });
  };
}
