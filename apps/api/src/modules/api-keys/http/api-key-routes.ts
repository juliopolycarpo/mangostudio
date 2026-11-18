import {
  CreateApiKeyBodySchema,
  CreateApiKeyResponseSchema,
  ListApiKeysResponseSchema,
} from '@mangostudio/shared/api-keys';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, status, t } from 'elysia';

import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireCookieAuth } from '../../../plugins/auth-middleware';
import {
  ApiKeyServiceError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../application/api-key-service';

function handleApiKeyError(error: unknown) {
  if (error instanceof ApiKeyServiceError) {
    return apiErrorStatus(error.status, { error: error.message, code: error.code });
  }

  console.error('[api-keys] Unexpected API key management error');
  return status(500, {
    error: 'Unexpected API key management error.',
    code: ERROR_CODES.INTERNAL,
  });
}

// No `as const`: it makes Eden type the spread `error` channel as `unknown`.
const errorResponses = {
  400: ApiErrorResponseSchema,
  401: ApiErrorResponseSchema,
  403: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
};

export const apiKeyRoutes = new Elysia().use(requireCookieAuth).group('/api-keys', (app) =>
  app
    .get(
      '/',
      {
        response: {
          200: ListApiKeysResponseSchema,
          ...errorResponses,
        },
      },
      async ({ request, user }) => {
        try {
          return await listApiKeys({
            userId: user?.id ?? '',
            headers: request.headers,
          });
        } catch (error) {
          return handleApiKeyError(error);
        }
      }
    )
    .post(
      '/',
      {
        body: CreateApiKeyBodySchema,
        response: {
          201: CreateApiKeyResponseSchema,
          ...errorResponses,
        },
      },
      async ({ body, request, set, user }) => {
        try {
          const response = await createApiKey(
            { userId: user?.id ?? '', headers: request.headers },
            body
          );
          set.status = 201;
          return response;
        } catch (error) {
          return handleApiKeyError(error);
        }
      }
    )
    .delete(
      '/:id',
      {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      },
      async ({ params, request, set, user }) => {
        try {
          await revokeApiKey({ userId: user?.id ?? '', headers: request.headers }, params.id);
          set.status = 204;
          return undefined;
        } catch (error) {
          return handleApiKeyError(error);
        }
      }
    )
);
