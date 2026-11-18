import {
  EnvironmentIdSchema,
  InstallBlockedResponseSchema,
  InstallCancelResponseSchema,
  InstallPreparationSchema,
  InstallPrepareBodySchema,
  InstallRecipePreviewSchema,
  InstallRunListSchema,
  InstallStartBodySchema,
  InstallStartResponseSchema,
} from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, status, t } from 'elysia';

import type { GuardIpPolicy } from '../../../lib/client-ip';
import { getConfig } from '../../../lib/config';
import { ProfileMismatchError } from '../../../lib/profile-context';
import { sseResponse } from '../../../lib/sse-stream';
import { requireAuth } from '../../../plugins/auth-middleware';
import { guardClientIp } from '../../../plugins/guard-client-ip';
import {
  InstallBlockedError,
  InstallConflictError,
  InstallPreparationError,
  type InstallRequestContext,
  type InstallService,
  installService,
  InstallUnavailableError,
} from '../application/install-service';
import { RecipeInputError } from '../domain/recipe-input';
import { InstallerDownloadError } from '../infrastructure/installer-download';

const runIdParams = t.Object({ runId: t.String({ minLength: 1 }) });

function requestContext(input: {
  userId: string;
  peerIp?: string;
  request: Request;
  includeSignal?: boolean;
}): InstallRequestContext {
  return {
    userId: input.userId,
    clientIp: input.peerIp,
    ...(input.includeSignal && { signal: input.request.signal }),
  };
}

function blockedResponse(error: InstallBlockedError) {
  return {
    error: error.message,
    code: ERROR_CODES.PERMISSION_DENIED,
    details: { reasons: error.recipe.guard.reasons.join(',') },
    recipe: error.recipe,
  };
}

function unavailableResponse(error: InstallUnavailableError) {
  return {
    error: error.message,
    code: ERROR_CODES.UNSUPPORTED,
    recipe: error.recipe,
  };
}

function mapInstallError(error: unknown) {
  if (error instanceof InstallBlockedError) {
    return status(403, blockedResponse(error));
  }
  if (error instanceof InstallUnavailableError) {
    return status(409, unavailableResponse(error));
  }
  if (error instanceof InstallConflictError || error instanceof InstallPreparationError) {
    return status(409, { error: error.message, code: ERROR_CODES.CONFLICT });
  }
  if (error instanceof RecipeInputError) {
    return status(422, { error: error.message, code: ERROR_CODES.VALIDATION });
  }
  if (error instanceof ProfileMismatchError) {
    return status(400, { error: error.message, code: ERROR_CODES.VALIDATION });
  }
  if (error instanceof InstallerDownloadError) {
    return status(502, { error: error.message, code: ERROR_CODES.INTERNAL });
  }
  throw error;
}

export function createInstallRoutes(
  service: InstallService = installService,
  policy: () => GuardIpPolicy = () => getConfig().security
) {
  return new Elysia()
    .use(requireAuth)
    .use(guardClientIp(policy))
    .get(
      '/environments/install/recipes',
      {
        query: t.Object({ environmentId: t.Optional(EnvironmentIdSchema) }),
        response: { 200: t.Array(InstallRecipePreviewSchema) },
      },
      ({ user, guardClientIp, request, query }) =>
        service.listRecipes({
          ...requestContext({
            userId: user?.id ?? '',
            peerIp: guardClientIp,
            request,
          }),
          ...(query.environmentId ? { environmentId: query.environmentId } : {}),
        })
    )
    .post(
      '/environments/install/prepare',
      {
        body: InstallPrepareBodySchema,
        response: {
          200: InstallPreparationSchema,
          400: ApiErrorResponseSchema,
          403: InstallBlockedResponseSchema,
          409: t.Union([InstallBlockedResponseSchema, ApiErrorResponseSchema]),
          422: ApiErrorResponseSchema,
          502: ApiErrorResponseSchema,
        },
      },
      async ({ body, user, guardClientIp, request }) => {
        try {
          return await service.prepare(
            body,
            requestContext({
              userId: user?.id ?? '',
              peerIp: guardClientIp,
              request,
              includeSignal: true,
            })
          );
        } catch (error) {
          return mapInstallError(error);
        }
      }
    )
    .post(
      '/environments/install',
      {
        body: InstallStartBodySchema,
        response: {
          200: InstallStartResponseSchema,
          400: ApiErrorResponseSchema,
          403: InstallBlockedResponseSchema,
          409: t.Union([InstallBlockedResponseSchema, ApiErrorResponseSchema]),
          422: ApiErrorResponseSchema,
          502: ApiErrorResponseSchema,
        },
      },
      async ({ body, user, guardClientIp, request }) => {
        try {
          return await service.start(
            body,
            requestContext({
              userId: user?.id ?? '',
              peerIp: guardClientIp,
              request,
              includeSignal: true,
            })
          );
        } catch (error) {
          return mapInstallError(error);
        }
      }
    )
    .get(
      '/environments/install/runs',
      {
        response: { 200: InstallRunListSchema },
      },
      ({ user }) => service.listRuns(user?.id ?? '')
    )
    .post(
      '/environments/install/:runId/cancel',
      {
        params: runIdParams,
        response: {
          200: InstallCancelResponseSchema,
          404: ApiErrorResponseSchema,
        },
      },
      async ({ params, user }) => {
        const result = await service.cancel(params.runId, user?.id ?? '');
        if (result) return result;
        return status(404, { error: 'Install run not found.', code: ERROR_CODES.NOT_FOUND });
      }
    )
    .get(
      '/environments/install/:runId/log',
      {
        params: runIdParams,
        response: {
          404: ApiErrorResponseSchema,
        },
      },
      async ({ params, user }) => {
        const source = await service.getRunStream(params.runId, user?.id ?? '');
        if (!source) {
          return status(404, { error: 'Install run not found.', code: ERROR_CODES.NOT_FOUND });
        }
        return sseResponse(source, 'Install log stream failed.');
      }
    );
}
