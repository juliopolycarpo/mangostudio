/**
 * Counter-key resolution for the rate limiter (#737).
 *
 * Every bucket keys on the caller IP except `api-key`, which keys on the
 * verified Better Auth key id so two keys behind one address count apart. A
 * request whose key does not verify keeps the IP key. That is the property that
 * stops a caller rotating garbage `x-api-key` values from minting a fresh
 * counter each time: every failed attempt lands on the same per-IP counter, and
 * `apiKeyGuard` answers it 401 from the memoized verification.
 *
 * The key id is never derived from the unverified header, only from a result
 * Better Auth vouched for.
 */

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';

import { type ApiKeyVerifier, isApiKeyVerifiedPath } from './api-key-verification';
import { RATE_LIMIT_BUCKETS } from './rate-limit-policy';
import type { RateLimitBucket } from './rate-limit-types';

export interface RateLimitClientIdInput {
  bucket: RateLimitBucket;
  request: Request;
  path: string;
  clientIp: string;
}

export type RateLimitClientIdResolver = (input: RateLimitClientIdInput) => Promise<string>;

/** Prefix that keeps a key id from ever colliding with an IP in the same bucket. */
const KEY_ID_PREFIX = 'key:';

export function createRateLimitClientIdResolver(
  verifier: ApiKeyVerifier
): RateLimitClientIdResolver {
  return async ({ bucket, request, path, clientIp }) => {
    if (bucket.name !== RATE_LIMIT_BUCKETS.apiKey.name) return clientIp;
    const key = request.headers.get(API_KEY_HEADER);
    // Paths the guard does not verify never get a key id from here either.
    if (!key || !isApiKeyVerifiedPath(path)) return clientIp;

    try {
      const verification = await verifier.verify(request, key);
      if (verification.valid && verification.key) return `${KEY_ID_PREFIX}${verification.key.id}`;
    } catch {
      // Fall back to the IP. The guard awaits the same verification and fails
      // the request the way it always has; the limiter must not turn a Better
      // Auth outage into a second failure mode.
    }
    return clientIp;
  };
}
