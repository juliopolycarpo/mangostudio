import { describe, expect, it } from 'bun:test';
import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import {
  classifyRateLimit,
  isAuthPath,
  isHealthPath,
  isProbeForcePath,
  RATE_LIMIT_BUCKETS,
  resolveRateLimitClientId,
} from '../../../src/plugins/rate-limit-policy';

function headersWithApiKey(value: string): Headers {
  return new Headers({ [API_KEY_HEADER]: value });
}

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
    expect(classifyRateLimit('/api/ws')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('leaves runtime dial-in upgrades to the route that can answer them', () => {
    // Exempt from the HTTP hook, not unlimited: the same bucket is counted in
    // `runtime-socket-routes`, which refuses with a close code instead of a 429
    // a dialing peer has no framing to read.
    expect(classifyRateLimit('/api/runtime')).toBeNull();
    expect(classifyRateLimit('/runtime')).toBeNull();
    // Only the endpoint itself: everything below it is ordinary API traffic.
    expect(classifyRateLimit('/api/runtimes')).toBe(RATE_LIMIT_BUCKETS.general);
    expect(classifyRateLimit('/api/runtime/anything')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('sizes the runtime bucket above a single reconnect cadence', () => {
    // Buckets key on client IP, so several runtimes behind one NAT share this
    // counter. A budget tuned to a single backoff curve would let one broken
    // runtime rate-limit every healthy one beside it.
    expect(RATE_LIMIT_BUCKETS.runtimeSocket.max).toBeGreaterThanOrEqual(60);
  });

  it('routes key-authenticated traffic to the api-key bucket', () => {
    const headers = headersWithApiKey('mango_test_secret_value');
    expect(classifyRateLimit('/api/chats', headers)).toBe(RATE_LIMIT_BUCKETS.apiKey);
  });

  it('keeps health and auth precedence over the api-key header', () => {
    const headers = headersWithApiKey('mango_test_secret_value');
    expect(classifyRateLimit('/api/health', headers)).toBe(RATE_LIMIT_BUCKETS.health);
    expect(classifyRateLimit('/api/auth/session', headers)).toBe(RATE_LIMIT_BUCKETS.auth);
  });

  it('does not misclassify look-alike paths as health or auth', () => {
    // `/api/authors` and `/api/healthcheck` must not match the auth/health groups.
    expect(isAuthPath('/api/authors')).toBe(false);
    expect(isHealthPath('/api/healthcheck')).toBe(false);
    expect(classifyRateLimit('/api/authors')).toBe(RATE_LIMIT_BUCKETS.general);
    expect(classifyRateLimit('/api/healthcheck')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('routes the three forced-probe routes to their own bucket', () => {
    expect(classifyRateLimit('/api/environments/runtimes/bun/probe', undefined, 'POST')).toBe(
      RATE_LIMIT_BUCKETS.probeForce
    );
    expect(classifyRateLimit('/environments/version-managers/nvm/probe', undefined, 'POST')).toBe(
      RATE_LIMIT_BUCKETS.probeForce
    );
    expect(classifyRateLimit('/api/environments/agents/claude/probe', undefined, 'POST')).toBe(
      RATE_LIMIT_BUCKETS.probeForce
    );
    expect(classifyRateLimit('/api/environments/runtimes/bun/probe/', undefined, 'POST')).toBe(
      RATE_LIMIT_BUCKETS.probeForce
    );
    expect(classifyRateLimit('/environments/agents/claude/probe/', undefined, 'POST')).toBe(
      RATE_LIMIT_BUCKETS.probeForce
    );
  });

  it('does not count non-POST probe-path requests against the forced-probe bucket', () => {
    expect(classifyRateLimit('/api/environments/runtimes/bun/probe', undefined, 'GET')).toBe(
      RATE_LIMIT_BUCKETS.general
    );
    expect(classifyRateLimit('/api/environments/runtimes/bun/probe', undefined, 'OPTIONS')).toBe(
      RATE_LIMIT_BUCKETS.general
    );
    expect(classifyRateLimit('/api/environments/runtimes/bun/probe')).toBe(
      RATE_LIMIT_BUCKETS.general
    );
  });

  it('does not misclassify neighboring environments routes as forced probes', () => {
    expect(isProbeForcePath('/api/environments/runtimes')).toBe(false);
    expect(isProbeForcePath('/api/environments/runtimes/bun')).toBe(false);
    expect(isProbeForcePath('/api/environments/runtimes/bun/probe/extra')).toBe(false);
    expect(isProbeForcePath('/api/environments/runtimes/bun/probe/extra/')).toBe(false);
    expect(classifyRateLimit('/api/environments/runtimes/bun')).toBe(RATE_LIMIT_BUCKETS.general);
  });

  it('keeps health, auth, and api-key more lenient than the general bucket', () => {
    // The user requirement: health/auth must not inherit the stronger general
    // limit, but must still be bounded.
    expect(RATE_LIMIT_BUCKETS.auth.max).toBeGreaterThanOrEqual(RATE_LIMIT_BUCKETS.general.max);
    expect(RATE_LIMIT_BUCKETS.health.max).toBeGreaterThanOrEqual(RATE_LIMIT_BUCKETS.general.max);
    expect(RATE_LIMIT_BUCKETS.apiKey.max).toBeGreaterThanOrEqual(RATE_LIMIT_BUCKETS.general.max);
    expect(Number.isFinite(RATE_LIMIT_BUCKETS.auth.max)).toBe(true);
    expect(Number.isFinite(RATE_LIMIT_BUCKETS.health.max)).toBe(true);
    expect(Number.isFinite(RATE_LIMIT_BUCKETS.apiKey.max)).toBe(true);
  });
});

describe('resolveRateLimitClientId', () => {
  it('keys the api-key bucket by client IP until verified key ids exist', () => {
    // Hashing the raw header would let rotating garbage keys escape the limiter
    // before apiKeyGuard runs. Isolation still comes from the separate bucket.
    const headers = headersWithApiKey('mango_same_key');
    expect(resolveRateLimitClientId(RATE_LIMIT_BUCKETS.apiKey, headers, '1.2.3.4')).toBe('1.2.3.4');
    expect(resolveRateLimitClientId(RATE_LIMIT_BUCKETS.apiKey, headers, '9.9.9.9')).toBe('9.9.9.9');
  });

  it('uses client IP for non api-key buckets', () => {
    expect(
      resolveRateLimitClientId(RATE_LIMIT_BUCKETS.general, headersWithApiKey('k'), '5.5.5.5')
    ).toBe('5.5.5.5');
  });

  it('uses client IP when the api-key bucket has no header', () => {
    expect(resolveRateLimitClientId(RATE_LIMIT_BUCKETS.apiKey, new Headers(), '5.5.5.5')).toBe(
      '5.5.5.5'
    );
  });
});
