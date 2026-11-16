/**
 * Auth routes: bridge between Elysia and Better Auth.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import type { Kysely } from 'kysely';

import { getAuth } from '../auth';
import { getDb } from '../db/database';
import { withFullDurability } from '../db/durability';
import type { Database } from '../db/types';
import { createDiagnosticLogger } from '../lib/logger';

const BETTER_AUTH_ACCEPT_METHODS = ['GET', 'POST'];
const ALLOWED_AUTH_METHODS = BETTER_AUTH_ACCEPT_METHODS.join(', ');
const authLogger = createDiagnosticLogger('auth-plugin');

/**
 * Hands a request to Better Auth with the database at `FULL`. Sign-out, session
 * revocation and a password change (which can revoke other sessions) all delete credentials there,
 * and a power loss must not bring one back after the user was told it was gone.
 * Sign-in commits its session durably too; these are rare, small writes.
 */
export function handleAuthRequest(
  request: Request,
  deps: {
    readonly db: Kysely<Database>;
    readonly handler: (request: Request) => Promise<Response>;
  } = { db: getDb(), handler: (incoming) => getAuth().handler(incoming) }
): Promise<Response> {
  return withFullDurability(deps.db, 'auth_request', () => deps.handler(request));
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
      .all('/*', { parse: 'none' }, (context) => {
        authLogger.info('request', { method: context.request.method, path: context.path });

        if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
          return handleAuthRequest(context.request);
        }
        context.set.status = 405;
        context.set.headers ??= {};
        context.set.headers.Allow = ALLOWED_AUTH_METHODS;
        return {
          error: 'Method not allowed',
          code: ERROR_CODES.METHOD_NOT_ALLOWED,
        } satisfies ApiErrorResponse;
      })
  );
