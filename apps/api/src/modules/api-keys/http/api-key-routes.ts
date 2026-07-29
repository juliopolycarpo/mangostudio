import {
  CreateApiKeyBodySchema,
  type CreateApiKeyResponse,
  CreateApiKeyResponseSchema,
  type ListApiKeysResponse,
  ListApiKeysResponseSchema,
} from '@mangostudio/shared/api-keys';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { requireCookieAuth } from '../../../plugins/auth-middleware';
import {
  ApiKeyServiceError,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from '../application/api-key-service';

function handleApiKeyError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof ApiKeyServiceError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[api-keys] Unexpected API key management error');
  set.status = 500;
  return { error: 'Unexpected API key management error.', code: ERROR_CODES.INTERNAL };
}

const errorResponses = {
  400: ApiErrorResponseSchema,
  401: ApiErrorResponseSchema,
  403: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
} as const;

export const apiKeyRoutes = new Elysia().use(requireCookieAuth).group('/api-keys', (app) =>
  app
    .get(
      '/',
      async ({ request, set, user }): Promise<ListApiKeysResponse | ApiErrorResponse> => {
        try {
          return await listApiKeys({
            userId: user?.id ?? '',
            headers: request.headers,
          });
        } catch (error) {
          return handleApiKeyError(error, set);
        }
      },
      {
        response: {
          200: ListApiKeysResponseSchema,
          ...errorResponses,
        },
      }
    )
    .post(
      '/',
      async ({ body, request, set, user }): Promise<CreateApiKeyResponse | ApiErrorResponse> => {
        try {
          const response = await createApiKey(
            { userId: user?.id ?? '', headers: request.headers },
            body
          );
          set.status = 201;
          return response;
        } catch (error) {
          return handleApiKeyError(error, set);
        }
      },
      {
        body: CreateApiKeyBodySchema,
        response: {
          201: CreateApiKeyResponseSchema,
          ...errorResponses,
        },
      }
    )
    .delete(
      '/:id',
      async ({ params, request, set, user }): Promise<undefined | ApiErrorResponse> => {
        try {
          await revokeApiKey({ userId: user?.id ?? '', headers: request.headers }, params.id);
          set.status = 204;
          return undefined;
        } catch (error) {
          return handleApiKeyError(error, set);
        }
      },
      {
        params: t.Object({ id: t.String({ minLength: 1 }) }),
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      }
    )
);
