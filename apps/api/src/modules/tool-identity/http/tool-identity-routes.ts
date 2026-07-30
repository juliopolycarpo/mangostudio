import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  SubjectKeySchema,
  type ToolIdentityListResponse,
  ToolIdentityListResponseSchema,
  type ToolIdentityUpdateResponse,
  ToolIdentityUpdateResponseSchema,
  ToolIdentityUpdateSchema,
} from '@mangostudio/shared/tool-identity';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  listToolIdentities,
  resetToolIdentity,
  ToolIdentityError,
  updateToolIdentity,
} from '../application/tool-identity-service';

function handleToolIdentityError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof ToolIdentityError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[tool-identity] Unexpected tool identity error');
  set.status = 500;
  return { error: 'Unexpected tool identity error.', code: ERROR_CODES.INTERNAL };
}

const errorResponses = {
  401: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
} as const;

const subjectKeyParams = t.Object({ subjectKey: SubjectKeySchema });

export const toolIdentityRoutes = new Elysia().use(requireAuth).group('/tool-identities', (app) =>
  app
    .get(
      '/',
      async ({ set, user }): Promise<ToolIdentityListResponse | ApiErrorResponse> => {
        try {
          return await listToolIdentities(getDb(), user?.id ?? '');
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        response: {
          200: ToolIdentityListResponseSchema,
          ...errorResponses,
        },
      }
    )

    .put(
      '/:subjectKey',
      async ({
        body,
        params,
        set,
        user,
      }): Promise<ToolIdentityUpdateResponse | ApiErrorResponse> => {
        try {
          const identity = await updateToolIdentity(
            getDb(),
            user?.id ?? '',
            params.subjectKey,
            body
          );
          return { identity };
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        params: subjectKeyParams,
        body: ToolIdentityUpdateSchema,
        response: {
          200: ToolIdentityUpdateResponseSchema,
          ...errorResponses,
        },
      }
    )

    .delete(
      '/:subjectKey',
      async ({ params, set, user }): Promise<undefined | ApiErrorResponse> => {
        try {
          await resetToolIdentity(getDb(), user?.id ?? '', params.subjectKey);
          set.status = 204;
          return undefined;
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        params: subjectKeyParams,
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      }
    )
);
