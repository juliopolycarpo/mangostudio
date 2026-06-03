import { describe, expect, it } from 'bun:test';
import {
  classifyRateLimit,
  isAuthPath,
  isHealthPath,
  RATE_LIMIT_BUCKETS,
} from '../../../src/plugins/rate-limit-policy';

describe('rate-limit policy classification', () => {
  it('routes prefixed health paths to the health bucket', () => {
    // The limiter runs under `/api`, so the runtime path is prefixed.
    expect(classifyRateLimit('/api/health')).toBe(RATE_LIMIT_BUCKETS.health);
  });

  it('routes unprefixed health paths to the health bucket', () => {
    expect(classifyRateLimit('/health')).toBe(RATE_LIMIT_BUCKETS.health);
  });

  it('routes prefixed auth paths to the auth bucket', () => {
    expect(classifyRateLimit('/api/auth/session')).toBe(RATE_LIMIT_BUCKETS.auth);
    expect(classifyRateLimit('/api/auth/sign-in/email')).toBe(RATE_LIMIT_BUCKETS.auth);
    expect(classifyRateLimit('/api/auth')).toBe(RATE_LIMIT_BUCKETS.auth);
  });

  it('routes unprefixed auth paths to the auth bucket', () => {
    expect(classifyRateLimit('/auth/session')).toBe(RATE_LIMIT_BUCKETS.auth);
  });

  it('routes every other path to the general bucket', () => {
    expect(classifyRateLimit('/api/chats')).toBe(RATE_LIMIT_BUCKETS.general);
    expect(classifyRateLimit('/api/messages')).toBe(RATE_LIMIT_BUCKETS.general);
    expect(classifyRateLimit('/api/generate')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('does not misclassify look-alike paths as health or auth', () => {
    // `/api/authors` and `/api/healthcheck` must not match the auth/health groups.
    expect(isAuthPath('/api/authors')).toBe(false);
    expect(isHealthPath('/api/healthcheck')).toBe(false);
    expect(classifyRateLimit('/api/authors')).toBe(RATE_LIMIT_BUCKETS.general);
    expect(classifyRateLimit('/api/healthcheck')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('keeps health and auth more lenient than the general bucket', () => {
    // The user requirement: health/auth must not inherit the stronger general
    // limit, but must still be bounded.
    expect(RATE_LIMIT_BUCKETS.auth.max).toBeGreaterThanOrEqual(RATE_LIMIT_BUCKETS.general.max);
    expect(RATE_LIMIT_BUCKETS.health.max).toBeGreaterThanOrEqual(RATE_LIMIT_BUCKETS.general.max);
    expect(Number.isFinite(RATE_LIMIT_BUCKETS.auth.max)).toBe(true);
    expect(Number.isFinite(RATE_LIMIT_BUCKETS.health.max)).toBe(true);
  });
});
