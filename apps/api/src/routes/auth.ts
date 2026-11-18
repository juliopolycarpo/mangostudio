/**
 * Auth routes: bridge between Elysia and Better Auth.
 */

import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { type Elysia, status } from 'elysia';
import type { Kysely } from 'kysely';

import { AUTH_BASE_PATH, getAuth } from '../auth';
import { getDb } from '../db/database';
import { withFullDurability } from '../db/durability';
import type { Database } from '../db/types';
import { createDiagnosticLogger } from '../lib/logger';

const BETTER_AUTH_ACCEPT_METHODS = ['GET', 'POST'];
const ALLOWED_AUTH_METHODS = BETTER_AUTH_ACCEPT_METHODS.join(', ');
const authLogger = createDiagnosticLogger('auth-plugin');

/**
 * The Better Auth POST endpoints (paths after the base path) that delete or rotate
 * a credential: a session, a password or an API key. A power loss must not bring
 * one back after the user was told it was gone, so these commit at `FULL`.
 *
 * Every other endpoint stays at the connection's level. Sign-in and sign-up hash a
 * password for a long time, `get-session` runs on every authenticated page load,
 * and a session as created is not a revocation. `tests/unit/routes/auth-durability.test.ts`
 * lists every endpoint of the installed Better Auth and its plugins against this set
 * and fails when one is in neither it nor the list of endpoints that revoke nothing,
 * so an upgrade that adds a revoking endpoint cannot slip past unwrapped.
 */
export const CREDENTIAL_REVOKING_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/sign-out',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  '/change-password',
  '/reset-password',
  '/delete-user',
  '/unlink-account',
  '/api-key/delete',
  '/api-key/update',
]);

/** True for a POST to an endpoint in {@link CREDENTIAL_REVOKING_AUTH_PATHS}. */
export function isCredentialRevokingRequest(request: Request): boolean {
  if (request.method !== 'POST') return false;
  const { pathname } = new URL(request.url);
  if (!pathname.toLowerCase().startsWith(`${AUTH_BASE_PATH}/`)) return false;
  // Doubled and trailing slashes reach the same endpoint, so they must not dodge the match.
  const endpoint = pathname
    .slice(AUTH_BASE_PATH.length)
    .toLowerCase()
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '');
  return CREDENTIAL_REVOKING_AUTH_PATHS.has(endpoint);
}

/**
 * Hands a request to Better Auth. A credential-revoking one runs with the database
 * at `FULL` (see {@link CREDENTIAL_REVOKING_AUTH_PATHS}); the rest do not touch it.
 *
 * The body is read before the window opens. The route skips Elysia's parse, so
 * Better Auth reads the body itself, and a client that trickles it in would hold
 * every other write at `FULL` for as long as it likes. The handler gets the
 * buffered copy.
 */
export async function handleAuthRequest(
  request: Request,
  deps: {
    readonly db: Kysely<Database>;
    readonly handler: (request: Request) => Promise<Response>;
  } = { db: getDb(), handler: (incoming) => getAuth().handler(incoming) }
): Promise<Response> {
  if (!isCredentialRevokingRequest(request)) return deps.handler(request);
  const body = await request.arrayBuffer();
  const buffered = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
  });
  return withFullDurability(deps.db, 'auth_request', () => deps.handler(buffered));
}

// O Better Auth Elysia adapter precisa tratar chamadas em /api/auth
export const authRoutes = (app: Elysia) =>
  app.group('/auth', (app) =>
    app
      .get('/ok', () => ({ ok: true }))
      // `parse: 'none'` keeps Elysia from reading the body, because Better Auth
      // is handed the untouched `Request` and reads it itself. Registering any
      // globally scoped error handler makes the framework materialise the body
      // before the handler runs, which consumes the stream and leaves every
      // sign-up and sign-in failing with `Invalid JSON in request body`. Handing
      // over a re-created `Request` instead would be lossy, so the parse is
      // skipped rather than replayed.
      .all(
        '/*',
        {
          parse: 'none',
          // Only the route's own 405 is declared. Better Auth answers with a
          // `Response`, which Elysia hands back untouched, whatever its status.
          response: { 405: ApiErrorResponseSchema },
        },
        (context) => {
          authLogger.info('request', { method: context.request.method, path: context.path });

          if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
            return handleAuthRequest(context.request);
          }
          context.set.headers ??= {};
          context.set.headers.Allow = ALLOWED_AUTH_METHODS;
          return status(405, {
            error: 'Method not allowed',
            code: ERROR_CODES.METHOD_NOT_ALLOWED,
          });
        }
      )
  );
