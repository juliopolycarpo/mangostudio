/**
 * Auth routes: bridge between Elysia and Better Auth.
 */

import { type Elysia } from 'elysia';
import { getAuth } from '../auth';

// O Better Auth Elysia adapter precisa tratar chamadas em /api/auth
export const authRoutes = (app: Elysia) =>
  app.group('/auth', (app) =>
    app
      .get('/ok', () => ({ ok: true }))
      .all('/*', (context) => {
        // Debug logging
        console.warn(`[auth-plugin] ${context.request.method} ${context.path}`);

        const BETTER_AUTH_ACCEPT_METHODS = ['POST', 'GET'];
        if (BETTER_AUTH_ACCEPT_METHODS.includes(context.request.method)) {
          return getAuth().handler(context.request);
        }
        context.set.status = 405;
        return new Response('Method not allowed', { status: 405 });
      })
  );
