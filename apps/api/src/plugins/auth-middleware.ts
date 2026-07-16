import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import { getAuth } from '../auth';

/**
 * Plugin Elysia que resolve a sessão do usuário a partir dos cookies.
 * Disponibiliza `user` e `session` no contexto de todas as rotas descendentes.
 */
const authMiddleware = (app: Elysia) =>
  app.derive(async ({ request }) => {
    const session = await getAuth().api.getSession({
      headers: request.headers,
    });

    return {
      user: session?.user ?? null,
      session: session?.session ?? null,
    };
  });

/**
 * Guard que rejeita requests não autenticados com 401.
 * Usar com .use(requireAuth) nas rotas que precisam de proteção.
 */
export const requireAuth = (app: Elysia) =>
  app.use(authMiddleware).onBeforeHandle(({ user, set }) => {
    if (!user) {
      set.status = 401;
      return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED } satisfies ApiErrorResponse;
    }
  });
