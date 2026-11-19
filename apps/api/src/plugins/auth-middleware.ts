import { API_KEY_HEADER } from '@mangostudio/shared/api-keys';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, status } from 'elysia';

import { getAuth } from '../auth';
import { apiKeyVerifier } from './api-key-verification';

type AuthSession = NonNullable<
  Awaited<ReturnType<ReturnType<typeof getAuth>['api']['getSession']>>
>;

/**
 * Better Auth's login-session lifetime (7 days): `auth.ts` sets no
 * `session.expiresIn`, and the api-key hook gives a key without an expiry this
 * lifetime, so the key session mirrors it.
 */
const DEFAULT_SESSION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolves an `x-api-key` request to its owner and a session-shaped record, or
 * null when the key does not verify (unknown, disabled, expired, exhausted) or
 * its owner no longer exists.
 *
 * Better Auth would build this same session itself: with the api-key plugin's
 * `enableSessionForAPIKeys` on, `getSession` runs a before-hook that validates
 * the key, then loads the owner. But that hook is a second validation next to
 * the one the rate limiter and `apiKeyGuard` share (api-key-verification.ts), and
 * every validation writes the key row (`lastRequest`, `updatedAt`) and, for a key
 * with a `remaining` quota, consumes one use. Reusing the shared per-request
 * verification keeps it to one validation, so a quota advances by one per request.
 *
 * The session mirrors the hook's, with two deliberate differences: `token` is the
 * key id rather than the raw key (the credential never enters the Elysia context),
 * and `ipAddress` is null (nothing reads it).
 */
async function resolveApiKeySession(request: Request, rawKey: string): Promise<AuthSession | null> {
  const verification = await apiKeyVerifier.verify(request, rawKey);
  if (!verification.valid || !verification.key) return null;
  const { key } = verification;

  const { internalAdapter } = await getAuth().$context;
  const user = await internalAdapter.findUserById(key.referenceId);
  if (!user) return null;

  const now = new Date();
  return {
    user,
    session: {
      id: key.id,
      token: key.id,
      userId: key.referenceId,
      userAgent: request.headers.get('user-agent'),
      ipAddress: null,
      createdAt: now,
      updatedAt: now,
      expiresAt: key.expiresAt ?? new Date(now.getTime() + DEFAULT_SESSION_LIFETIME_MS),
    },
  };
}

/**
 * Plugin Elysia que resolve a sessão do usuário a partir dos cookies, ou, num
 * request com `x-api-key`, a partir da chave (ver resolveApiKeySession).
 * Disponibiliza `user` e `session` no contexto de todas as rotas descendentes.
 *
 * Named so Elysia dedupes it: dozens of route modules `.use(requireAuth)`,
 * and without plugin identity the async derive would re-register and re-run
 * once per module instead of once per request.
 */
const authMiddleware = new Elysia({ name: 'auth-middleware' }).derive(
  'plugin',
  async ({ request }) => {
    const apiKey = request.headers.get(API_KEY_HEADER);
    const session = apiKey
      ? await resolveApiKeySession(request, apiKey)
      : await getAuth().api.getSession({ headers: request.headers });

    return {
      user: session?.user ?? null,
      session: session?.session ?? null,
      authenticationMethod: session ? (apiKey ? ('api-key' as const) : ('session' as const)) : null,
    };
  }
);

/**
 * Guard que rejeita requests não autenticados com 401.
 * Usar com .use(requireAuth) nas rotas que precisam de proteção.
 */
export const requireAuth = new Elysia({ name: 'require-auth' })
  .use(authMiddleware)
  .onBeforeHandle('plugin', ({ user }) => {
    if (!user) {
      return status(401, {
        error: 'Unauthorized',
        code: ERROR_CODES.UNAUTHORIZED,
      } satisfies ApiErrorResponse);
    }
  })
  .as('plugin');

/**
 * Stronger authenticated-route guard for credential-management surfaces.
 * Valid API keys resolve through Better Auth like sessions, so the derived
 * authentication method is the reliable distinction after authentication.
 */
export const requireCookieAuth = new Elysia({ name: 'require-cookie-auth' })
  .use(requireAuth)
  .onBeforeHandle('plugin', ({ authenticationMethod }) => {
    if (authenticationMethod === 'api-key') {
      return status(403, {
        error: 'API keys cannot manage API keys',
        code: ERROR_CODES.API_KEY_SCOPE_FORBIDDEN,
      } satisfies ApiErrorResponse);
    }
  })
  .as('plugin');
