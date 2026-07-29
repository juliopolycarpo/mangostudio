import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { isAPIError } from 'better-auth/api';
import { Elysia } from 'elysia';
import { getAuth } from '../auth';

/**
 * True when getSession failed because the x-api-key header was present but
 * invalid/expired/disabled — the api-key plugin's enableSessionForAPIKeys
 * before-hook throws UNAUTHORIZED or FORBIDDEN for those cases instead of
 * resolving to null. Duck-typed via isAPIError (name === "APIError" fallback)
 * so the dual-package @better-auth/core hazard does not break the check.
 */
function isExpectedApiKeySessionFailure(error: unknown): boolean {
  if (!isAPIError(error)) return false;
  return error.statusCode === 401 || error.statusCode === 403;
}

/**
 * Plugin Elysia que resolve a sessão do usuário a partir dos cookies.
 * Disponibiliza `user` e `session` no contexto de todas as rotas descendentes.
 *
 * Named so Elysia dedupes it: dozens of route modules `.use(requireAuth)`,
 * and without plugin identity the async `getSession` derive would re-register
 * and re-run once per module instead of once per request.
 */
const authMiddleware = new Elysia({ name: 'auth-middleware' }).derive(
  { as: 'scoped' },
  async ({ request }) => {
    // With the api-key plugin's enableSessionForAPIKeys on, getSession throws
    // a Better Auth APIError for an invalid/expired x-api-key header instead
    // of resolving to null. Treat only that case as "no session" — the
    // downstream 401 in requireAuth (or api-key-guard's own check) is the
    // right response. Unexpected failures (DB/config) must still surface.
    const session = await getAuth()
      .api.getSession({ headers: request.headers })
      .catch((error: unknown) => {
        if (!isExpectedApiKeySessionFailure(error)) throw error;
        return null;
      });

    return {
      user: session?.user ?? null,
      session: session?.session ?? null,
      authenticationMethod: session
        ? request.headers.has(API_KEY_HEADER)
          ? ('api-key' as const)
          : ('session' as const)
        : null,
    };
  }
);

/**
 * Guard que rejeita requests não autenticados com 401.
 * Usar com .use(requireAuth) nas rotas que precisam de proteção.
 */
export const requireAuth = new Elysia({ name: 'require-auth' })
  .use(authMiddleware)
  .onBeforeHandle({ as: 'scoped' }, ({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } satisfies ApiErrorResponse;
    }
  })
  .as('scoped');

/**
 * Stronger authenticated-route guard for credential-management surfaces.
 * Valid API keys resolve through Better Auth like sessions, so the derived
 * authentication method is the reliable distinction after authentication.
 */
export const requireCookieAuth = new Elysia({ name: 'require-cookie-auth' })
  .use(requireAuth)
  .onBeforeHandle({ as: 'scoped' }, ({ authenticationMethod, set }) => {
    if (authenticationMethod === 'api-key') {
      set.status = 403;
      return {
        error: 'API keys cannot manage API keys',
        code: ERROR_CODES.API_KEY_SCOPE_FORBIDDEN,
      } satisfies ApiErrorResponse;
    }
  })
  .as('scoped');
