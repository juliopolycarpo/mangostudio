import {
  CreateEnvironmentBodySchema,
  EnvironmentIdSchema,
  EnvironmentListSchema,
  EnvironmentSchema,
  UpdateEnvironmentBodySchema,
} from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  type EnvironmentService,
  EnvironmentServiceError,
} from '../application/environment-service';

const environmentParams = t.Object({ id: EnvironmentIdSchema });

function environmentError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof EnvironmentServiceError) {
    set.status = error.status;
    return {
      error: error.message,
      code:
        error.status === 404
          ? ERROR_CODES.NOT_FOUND
          : error.status === 409
            ? ERROR_CODES.CONFLICT
            : ERROR_CODES.VALIDATION,
    };
  }
  throw error;
}

export function createEnvironmentEntityRoutes(service: EnvironmentService) {
  return new Elysia()
    .use(requireAuth)
    .get('/environments', ({ user }) => service.list(user?.id ?? ''), {
      response: { 200: EnvironmentListSchema },
    })
    .post(
      '/environments',
      async ({ body, user, set }) => {
        try {
          set.status = 201;
          return await service.create(user?.id ?? '', body);
        } catch (error) {
          return environmentError(error, set);
        }
      },
      {
        body: CreateEnvironmentBodySchema,
        response: {
          201: EnvironmentSchema,
          400: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/environments/:id',
      async ({ params, user, set }) => {
        const environment = await service.find(user?.id ?? '', params.id);
        if (environment) return environment;
        set.status = 404;
        return {
          error: `Environment "${params.id}" was not found.`,
          code: ERROR_CODES.NOT_FOUND,
        };
      },
      {
        params: environmentParams,
        response: {
          200: EnvironmentSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .put(
      '/environments/:id',
      async ({ params, body, user, set }) => {
        try {
          return await service.update(user?.id ?? '', params.id, body);
        } catch (error) {
          return environmentError(error, set);
        }
      },
      {
        params: environmentParams,
        body: UpdateEnvironmentBodySchema,
        response: {
          200: EnvironmentSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      }
    )
    .delete(
      '/environments/:id',
      async ({ params, user, set }) => {
        try {
          await service.remove(user?.id ?? '', params.id);
          return { success: true as const };
        } catch (error) {
          return environmentError(error, set);
        }
      },
      {
        params: environmentParams,
        response: {
          200: t.Object({ success: t.Literal(true) }),
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/:id/connect',
      async ({ params, user, set }) => {
        try {
          return await service.connect(user?.id ?? '', params.id);
        } catch (error) {
          return environmentError(error, set);
        }
      },
      {
        params: environmentParams,
        response: {
          200: EnvironmentSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/:id/disconnect',
      async ({ params, user, set }) => {
        try {
          return await service.disconnect(user?.id ?? '', params.id);
        } catch (error) {
          return environmentError(error, set);
        }
      },
      {
        params: environmentParams,
        response: {
          200: EnvironmentSchema,
          404: ApiErrorResponseSchema,
        },
      }
    );
}
