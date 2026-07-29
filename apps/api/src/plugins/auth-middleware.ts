import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia } from 'elysia';
import { getAuth } from '../auth';

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
    // of resolving to null. Treat that the same as "no session" — the
    // downstream 401 in requireAuth (or api-key-guard's own check) is the
    // right response, not an uncaught crash through this derive.
    const session = await getAuth()
      .api.getSession({ headers: request.headers })
      .catch(() => null);

    return {
      user: session?.user ?? null,
      session: session?.session ?? null,
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
