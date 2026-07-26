import type { RuntimeId, RuntimeStatus } from '@mangostudio/shared/environments';
import {
  RuntimeIdSchema,
  RuntimeStatusListSchema,
  RuntimeStatusSchema,
} from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  type RuntimeDetectionService,
  runtimeDetectionService,
} from '../application/runtime-detection';

const runtimeIdParams = t.Object({ id: RuntimeIdSchema });

async function getRuntimeOrNotFound(
  service: RuntimeDetectionService,
  id: RuntimeId,
  force: boolean,
  set: { status?: number | string }
): Promise<RuntimeStatus | ApiErrorResponse> {
  const status = await service.getRuntimeStatus(id, { force });
  if (status) return status;

  set.status = 404;
  return {
    error: `Runtime detection is not available for ${id}.`,
    code: ERROR_CODES.NOT_FOUND,
  };
}

export function createEnvironmentRoutes(
  service: RuntimeDetectionService = runtimeDetectionService
) {
  return new Elysia()
    .use(requireAuth)
    .get('/environments/runtimes', () => service.listRuntimeStatuses(), {
      response: { 200: RuntimeStatusListSchema },
    })
    .get(
      '/environments/runtimes/:id',
      ({ params, set }) => getRuntimeOrNotFound(service, params.id, false, set),
      {
        params: runtimeIdParams,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/environments/runtimes/:id/probe',
      ({ params, set }) => getRuntimeOrNotFound(service, params.id, true, set),
      {
        params: runtimeIdParams,
        response: {
          200: RuntimeStatusSchema,
          404: ApiErrorResponseSchema,
        },
      }
    );
}

export const environmentRoutes = createEnvironmentRoutes();
