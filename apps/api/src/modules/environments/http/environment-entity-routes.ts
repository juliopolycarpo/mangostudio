import {
  CreateEnvironmentBodySchema,
  EnvironmentIdSchema,
  EnvironmentListSchema,
  EnvironmentSchema,
  RuntimePairingIssueSchema,
  RuntimePairingStatusSchema,
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
import {
  type RuntimePairingService,
  runtimePairingService,
} from '../application/runtime-pairing-service';

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
            : error.status === 503
              ? ERROR_CODES.PROVIDER_ERROR
              : ERROR_CODES.VALIDATION,
    };
  }
  throw error;
}

export function createEnvironmentEntityRoutes(
  service: EnvironmentService,
  pairing: RuntimePairingService = runtimePairingService
) {
  return (
    new Elysia()
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
            503: ApiErrorResponseSchema,
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
            503: ApiErrorResponseSchema,
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
      )
      .get(
        '/environments/:id/pairing',
        async ({ params, user, set }) => {
          try {
            return await pairing.status(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        },
        {
          params: environmentParams,
          response: {
            200: RuntimePairingStatusSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
        }
      )
      // POST rather than PUT: each call mints a new secret and retires the
      // previous one, so replaying it is not the same as sending it once.
      .post(
        '/environments/:id/pairing',
        async ({ params, user, set }) => {
          try {
            set.status = 201;
            return await pairing.issue(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        },
        {
          params: environmentParams,
          response: {
            201: RuntimePairingIssueSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
        }
      )
      .delete(
        '/environments/:id/pairing',
        async ({ params, user, set }) => {
          try {
            await pairing.revoke(user?.id ?? '', params.id);
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
  );
}
