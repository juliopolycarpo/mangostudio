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
import type { Elysia } from 'elysia';
import { getApiKeyApi, resolveApiKeyScope } from '../auth';
import { getDb } from '../db/database';
import { getSavedAppSettings } from '../modules/app-settings/infrastructure/app-settings-repository';
import { resolvePath } from './rate-limit';
import { isAuthPath, isRuntimeSocketPath } from './rate-limit-policy';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Matches the cookie-session-only key management routes with or without `/api`. */
function isApiKeyManagementPath(path: string): boolean {
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
 * either here with HTTP 401/403 would prevent that handshake path from running.
 *
 * Hardening rather than a prerequisite: a Bearer-only upgrade never reaches
 * this guard, which returns immediately without `x-api-key`. What this adds is
 * that an upgrade carrying a key header is refused by the route, with a close
 * code the peer can read, instead of by a guard it has no framing to hear.
 */
function isProtocolWebSocketPath(path: string): boolean {
  return path === '/ws' || path === '/api/ws' || isRuntimeSocketPath(path);
}

/** Mutable response controls Elysia exposes on the context. */
interface ApiKeyGuardSet {
  status?: number;
}

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
  set: ApiKeyGuardSet;
}

export function apiKeyGuard(app: Elysia) {
  return app.onBeforeHandle(async (context) => {
    const ctx = context as ApiKeyGuardContext;
    const key = ctx.request.headers.get(API_KEY_HEADER);
    if (!key) return;

    const path = resolvePath(ctx.path, ctx.request.url);

    if (isAuthPath(path)) {
      ctx.set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } satisfies ApiErrorResponse;
    }

    // Key-management routes own a stricter cookie-session-only response. Let
    // requireCookieAuth distinguish a valid key from an invalid credential so
    // the route consistently returns API_KEY_SCOPE_FORBIDDEN for key auth,
    // even while the account's external API toggle is disabled.
    if (isApiKeyManagementPath(path)) return;

    // These sockets own their credential policy after the upgrade completes.
    if (isProtocolWebSocketPath(path)) return;

    const result = await getApiKeyApi().verifyApiKey({ body: { key } });
    if (!result.valid || !result.key) {
      ctx.set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } satisfies ApiErrorResponse;
    }

    const settings = await getSavedAppSettings(getDb(), result.key.referenceId);
    if (!settings.externalApiSettings.enabled) {
      ctx.set.status = 403;
      return {
        error: 'The external API is disabled for this account',
        code: ERROR_CODES.EXTERNAL_API_DISABLED,
      } satisfies ApiErrorResponse;
    }

    const scope = resolveApiKeyScope(result.key.metadata);
    if (scope === 'read-only' && !SAFE_METHODS.has(ctx.request.method)) {
      ctx.set.status = 403;
      return {
        error: 'This API key is read-only',
        code: ERROR_CODES.API_KEY_SCOPE_FORBIDDEN,
      } satisfies ApiErrorResponse;
    }
  });
}
