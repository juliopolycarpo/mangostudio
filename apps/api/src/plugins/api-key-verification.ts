/**
 * One Better Auth key verification per request, shared by the rate limiter and
 * `apiKeyGuard`.
 *
 * The limiter needs the verified key id to key the `api-key` bucket (#737), and
 * the guard needs the verified record for the toggle and scope checks. Both run
 * as `onBeforeHandle` hooks, so neither can hand the result to the other through
 * the Elysia context without a derive that runs `verifyApiKey` ahead of every
 * hook, and a derive cannot be conditional on the path. A per-request memo keyed
 * by the `Request` object gives the same single verification with no context
 * plumbing, and reads only headers, so it never makes Elysia parse the body.
 */

import { type ApiKeyPluginApi, getApiKeyApi } from '../auth';
import { isAuthPath, isRuntimeSocketPath } from './rate-limit-policy';

/** What `verifyApiKey` resolves to; the guard and limiter read only these fields. */
export type ApiKeyVerification = Awaited<ReturnType<ApiKeyPluginApi['verifyApiKey']>>;

export interface ApiKeyVerifier {
  /**
   * Verify `key` for `request`. Repeat calls for the same `Request` share one
   * verification, including a failed one: a rejection is replayed, not retried.
   */
  verify(request: Request, key: string): Promise<ApiKeyVerification>;
}

/**
 * @param resolveApi - Port lookup, evaluated per verification so the auth
 *   singleton can be reset between tests.
 */
export function createApiKeyVerifier(
  resolveApi: () => Pick<ApiKeyPluginApi, 'verifyApiKey'> = getApiKeyApi
): ApiKeyVerifier {
  // Weak so an abandoned request releases its entry without a cleanup pass.
  const verifications = new WeakMap<Request, Promise<ApiKeyVerification>>();
  return {
    verify(request, key) {
      let verification = verifications.get(request);
      if (!verification) {
        verification = resolveApi().verifyApiKey({ body: { key } });
        verifications.set(request, verification);
      }
      return verification;
    },
  };
}

/** The verifier `app.ts` wires into both the limiter and the guard. */
export const apiKeyVerifier: ApiKeyVerifier = createApiKeyVerifier();

/** Matches the cookie-session-only key management routes with or without `/api`. */
export function isApiKeyManagementPath(path: string): boolean {
  return (
    path === '/api-keys' ||
    path.startsWith('/api-keys/') ||
    path === '/api/api-keys' ||
    path.startsWith('/api/api-keys/')
  );
}

/**
 * WebSocket upgrades that own their own credential policy. The realtime route
 * rejects `x-api-key` with its stable WS error + `4401` close, and `/api/runtime`
 * authenticates a pairing token over `Authorization: Bearer`; short-circuiting
 * either with HTTP 401/403 would prevent that handshake path from running.
 *
 * Hardening rather than a prerequisite: a Bearer-only upgrade never reaches
 * the guard, which returns immediately without `x-api-key`. What this adds is
 * that an upgrade carrying a key header is refused by the route, with a close
 * code the peer can read, instead of by a guard it has no framing to hear.
 */
export function isProtocolWebSocketPath(path: string): boolean {
  return path === '/ws' || path === '/api/ws' || isRuntimeSocketPath(path);
}

/**
 * True when `apiKeyGuard` verifies a key sent to `path`. Everywhere else the
 * guard either rejects without looking at the key (auth paths) or defers to the
 * route (key management, protocol sockets), so the limiter must not verify there
 * either: that path's key never becomes a counter key.
 */
export function isApiKeyVerifiedPath(path: string): boolean {
  return !isAuthPath(path) && !isApiKeyManagementPath(path) && !isProtocolWebSocketPath(path);
}
