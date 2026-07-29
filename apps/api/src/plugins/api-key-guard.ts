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
 */

import { API_KEY_HEADER, type ApiKeyScope } from '@mangostudio/shared/api-keys';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import { getApiKeyApi } from '../auth';
import { getDb } from '../db/database';
import { getSavedAppSettings } from '../modules/app-settings/infrastructure/app-settings-repository';
import { resolvePath } from './rate-limit';
import { isAuthPath } from './rate-limit-policy';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

export const apiKeyGuard = new Elysia({ name: 'api-key-guard' }).onBeforeHandle(
  { as: 'global' },
  async (context) => {
    const ctx = context as ApiKeyGuardContext;
    const key = ctx.request.headers.get(API_KEY_HEADER);
    if (!key) return;

    if (isAuthPath(resolvePath(ctx.path, ctx.request.url))) {
      ctx.set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } satisfies ApiErrorResponse;
    }

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

    const scope: ApiKeyScope = result.key.metadata?.scope === 'full' ? 'full' : 'read-only';
    if (scope === 'read-only' && !SAFE_METHODS.has(ctx.request.method)) {
      ctx.set.status = 403;
      return {
        error: 'This API key is read-only',
        code: ERROR_CODES.API_KEY_SCOPE_FORBIDDEN,
      } satisfies ApiErrorResponse;
    }
  }
);
