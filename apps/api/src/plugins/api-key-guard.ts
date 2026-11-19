/**
 * Authenticates external HTTP requests that carry an `x-api-key` header as
 * the key's owner, gated by a per-user "external API" toggle and a per-key
 * scope (`read-only` | `full`). A request without the header returns
 * immediately, so cookie-session traffic is untouched.
 *
 * Registered once on the `/api` instance rather than folded into
 * authMiddleware's derive (which re-runs per route module and never sees
 * `/api/auth/**`), so this runs exactly once per request and covers every
 * path uniformly. Does not derive `user`/`session` itself: with
 * `enableSessionForAPIKeys` on, Better Auth's own `getSession` (already
 * called by requireAuth's derive) resolves the key header into a session, so
 * a request that passes this guard authenticates through the existing path
 * unmodified. Elysia always runs the derive phase before onBeforeHandle
 * (regardless of plugin registration order), so requireAuth's session lookup
 * has already run by the time this guard's own checks execute — this guard
 * only adds the toggle/scope checks Better Auth's session resolution doesn't
 * know about.
 *
 * A plain function-style plugin — matching rate-limit.ts, not a named
 * `new Elysia({ name })` instance like errorHandler/requireAuth. It is only
 * ever `.use()`'d once (on the `api` instance in app.ts), so it needs
 * neither plugin deduplication nor scope propagation: chaining `.onBeforeHandle`
 * directly onto the passed-in `app` covers every route registered on it
 * afterward, the same way rate-limit.ts's hooks do.
 */

import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { type Elysia, status } from 'elysia';

import { resolveApiKeyScope } from '../auth';
import { getDb } from '../db/database';
import { getSavedAppSettings } from '../modules/app-settings/infrastructure/app-settings-repository';
import {
  type ApiKeyVerifier,
  apiKeyVerifier,
  isApiKeyManagementPath,
  isProtocolWebSocketPath,
} from './api-key-verification';
import { resolvePath } from './rate-limit';
import { isAuthPath } from './rate-limit-policy';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Minimal slice of the Elysia context this guard needs. Kept narrow and cast
 * (rather than destructured in the hook's own parameter list) because Elysia
 * statically analyzes hook source: destructuring `request` or referencing
 * the whole context makes it eagerly parse the body, consuming the stream
 * before the Better Auth passthrough in routes/auth.ts can read it. See
 * rate-limit.ts for the same constraint.
 */
interface ApiKeyGuardContext {
  path?: string;
  request: Request;
}

/**
 * @param verifier - Shared with the rate limiter so a request's key is verified
 *   once between them (see api-key-verification.ts).
 */
export function createApiKeyGuard(verifier: ApiKeyVerifier) {
  return (app: Elysia) =>
    app.onBeforeHandle(async (context) => {
      const ctx = context as ApiKeyGuardContext;
      const key = ctx.request.headers.get(API_KEY_HEADER);
      if (!key) return;

      const path = resolvePath(ctx.path, ctx.request.url);

      if (isAuthPath(path)) {
        return status(401, {
          error: 'Unauthorized',
          code: ERROR_CODES.UNAUTHORIZED,
        } satisfies ApiErrorResponse);
      }

      // Key-management routes own a stricter cookie-session-only response. Let
      // requireCookieAuth distinguish a valid key from an invalid credential so
      // the route consistently returns API_KEY_SCOPE_FORBIDDEN for key auth,
      // even while the account's external API toggle is disabled.
      if (isApiKeyManagementPath(path)) return;

      // These sockets own their credential policy after the upgrade completes.
      if (isProtocolWebSocketPath(path)) return;

      const result = await verifier.verify(ctx.request, key);
      if (!result.valid || !result.key) {
        return status(401, {
          error: 'Unauthorized',
          code: ERROR_CODES.UNAUTHORIZED,
        } satisfies ApiErrorResponse);
      }

      const settings = await getSavedAppSettings(getDb(), result.key.referenceId);
      if (!settings.externalApiSettings.enabled) {
        return status(403, {
          error: 'The external API is disabled for this account',
          code: ERROR_CODES.EXTERNAL_API_DISABLED,
        } satisfies ApiErrorResponse);
      }

      const scope = resolveApiKeyScope(result.key.metadata);
      if (scope === 'read-only' && !SAFE_METHODS.has(ctx.request.method)) {
        return status(403, {
          error: 'This API key is read-only',
          code: ERROR_CODES.API_KEY_SCOPE_FORBIDDEN,
        } satisfies ApiErrorResponse);
      }
    });
}

/** The production guard, wired to the verifier the rate limiter also uses. */
export const apiKeyGuard = createApiKeyGuard(apiKeyVerifier);
