import { describe, expect, it } from 'bun:test';

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';

import {
  type ApiKeyVerifier,
  createApiKeyVerifier,
  isApiKeyVerifiedPath,
} from '../../../src/plugins/api-key-verification';
import { createRateLimitClientIdResolver } from '../../../src/plugins/rate-limit-client-id';
import { RATE_LIMIT_BUCKETS } from '../../../src/plugins/rate-limit-policy';
import { FakeApiKeyVerifyApi } from '../../support/fake-api-key-verify-api';

const CLIENT_IP = '203.0.113.9';

function requestWithKey(key?: string): Request {
  return new Request('http://localhost/api/chats', {
    headers: key === undefined ? {} : { [API_KEY_HEADER]: key },
  });
}

/** A verifier whose Better Auth port is down. */
const failingVerifier: ApiKeyVerifier = {
  verify: () => Promise.reject(new Error('better-auth unavailable')),
};

describe('createRateLimitClientIdResolver', () => {
  const keyApi = new FakeApiKeyVerifyApi().register('mango_known', 'key-id-known', 'user-1');
  const resolve = createRateLimitClientIdResolver(createApiKeyVerifier(() => keyApi));

  it('keys the api-key bucket by the verified key id', async () => {
    const id = await resolve({
      bucket: RATE_LIMIT_BUCKETS.apiKey,
      request: requestWithKey('mango_known'),
      path: '/api/chats',
      clientIp: CLIENT_IP,
    });
    expect(id).toBe('key:key-id-known');
  });

  it('keeps the client IP for a key that does not verify', async () => {
    const id = await resolve({
      bucket: RATE_LIMIT_BUCKETS.apiKey,
      request: requestWithKey('garbage_value'),
      path: '/api/chats',
      clientIp: CLIENT_IP,
    });
    expect(id).toBe(CLIENT_IP);
  });

  it('keeps the client IP for non api-key buckets without verifying', async () => {
    const callsBefore = keyApi.verifiedKeys.length;
    const id = await resolve({
      bucket: RATE_LIMIT_BUCKETS.general,
      request: requestWithKey('mango_known'),
      path: '/api/chats',
      clientIp: CLIENT_IP,
    });
    expect(id).toBe(CLIENT_IP);
    expect(keyApi.verifiedKeys).toHaveLength(callsBefore);
  });

  it('keeps the client IP when the api-key bucket has no header', async () => {
    const id = await resolve({
      bucket: RATE_LIMIT_BUCKETS.apiKey,
      request: requestWithKey(),
      path: '/api/chats',
      clientIp: CLIENT_IP,
    });
    expect(id).toBe(CLIENT_IP);
  });

  it('keeps the client IP where the guard does not verify the key', async () => {
    const callsBefore = keyApi.verifiedKeys.length;
    for (const path of ['/api/api-keys', '/api/ws', '/api/auth/session']) {
      const id = await resolve({
        bucket: RATE_LIMIT_BUCKETS.apiKey,
        request: requestWithKey('mango_known'),
        path,
        clientIp: CLIENT_IP,
      });
      expect(id).toBe(CLIENT_IP);
    }
    expect(keyApi.verifiedKeys).toHaveLength(callsBefore);
  });

  it('falls back to the client IP when verification throws', async () => {
    const resolveWhileDown = createRateLimitClientIdResolver(failingVerifier);
    const id = await resolveWhileDown({
      bucket: RATE_LIMIT_BUCKETS.apiKey,
      request: requestWithKey('mango_known'),
      path: '/api/chats',
      clientIp: CLIENT_IP,
    });
    expect(id).toBe(CLIENT_IP);
  });
});

describe('createApiKeyVerifier', () => {
  it('shares one verification between callers holding the same request', async () => {
    const keyApi = new FakeApiKeyVerifyApi().register('mango_known', 'key-id-known', 'user-1');
    const verifier = createApiKeyVerifier(() => keyApi);
    const request = requestWithKey('mango_known');

    const [first, second] = await Promise.all([
      verifier.verify(request, 'mango_known'),
      verifier.verify(request, 'mango_known'),
    ]);

    expect(first).toBe(second);
    expect(keyApi.verifiedKeys).toEqual(['mango_known']);
  });

  it('verifies again for a different request', async () => {
    const keyApi = new FakeApiKeyVerifyApi().register('mango_known', 'key-id-known', 'user-1');
    const verifier = createApiKeyVerifier(() => keyApi);

    await verifier.verify(requestWithKey('mango_known'), 'mango_known');
    await verifier.verify(requestWithKey('mango_known'), 'mango_known');

    expect(keyApi.verifiedKeys).toHaveLength(2);
  });
});

describe('isApiKeyVerifiedPath', () => {
  it('matches the paths apiKeyGuard verifies and no others', () => {
    expect(isApiKeyVerifiedPath('/api/chats')).toBe(true);
    expect(isApiKeyVerifiedPath('/chats')).toBe(true);
    expect(isApiKeyVerifiedPath('/api/auth/session')).toBe(false);
    expect(isApiKeyVerifiedPath('/api/api-keys')).toBe(false);
    expect(isApiKeyVerifiedPath('/api/api-keys/abc')).toBe(false);
    expect(isApiKeyVerifiedPath('/api/ws')).toBe(false);
    expect(isApiKeyVerifiedPath('/api/runtime')).toBe(false);
  });
});
