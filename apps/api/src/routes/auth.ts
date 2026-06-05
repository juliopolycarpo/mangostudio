/**
 * Auth routes: bridge between Elysia and Better Auth.
 */

import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import { getAuth } from '../auth';
import { createDiagnosticLogger } from '../lib/logger';

const BETTER_AUTH_ACCEPT_METHODS = ['GET', 'POST'];
const ALLOWED_AUTH_METHODS = BETTER_AUTH_ACCEPT_METHODS.join(', ');
const authLogger = createDiagnosticLogger('auth-plugin');

// O Better Auth Elysia adapter precisa tratar chamadas em /api/auth
export const authRoutes = (app: Elysia) =>
  app.group('/auth', (app) =>
    app
      .get('/ok', () => ({ ok: true }))
      .all('/*', (context) => {
        authLogger.info('request', { method: context.request.method, path: context.path });

        if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
          return getAuth().handler(context.request);
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
