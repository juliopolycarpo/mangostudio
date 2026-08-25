import {
  ListActivityQuerySchema,
  type ListActivityResponse,
  ListActivityResponseSchema,
} from '@mangostudio/shared/activity';
import { type ApiErrorResponse, ApiErrorResponseSchema } from '@mangostudio/shared/errors';
import type { Elysia } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import { listActivity } from '../application/list-activity';

export const activityRoutes = (app: Elysia) =>
  app.group('/activity', (app) =>
    app.use(requireAuth).get(
      '/',
      {
        query: ListActivityQuerySchema,
        response: {
          200: ListActivityResponseSchema,
          401: ApiErrorResponseSchema,
        },
      },
      async ({ query, user }): Promise<ApiErrorResponse | ListActivityResponse> =>
        // `requireAuth` already rejected an anonymous request; the fallback only
        // keeps the handler total, and an empty user id matches no row.
        listActivity(user?.id ?? '', query)
    )
  );
