import {
  CreateEnvironmentBodySchema,
  EnvironmentIdSchema,
  EnvironmentListSchema,
  EnvironmentSchema,
  RuntimeLifecycleCancelResponseSchema,
  RuntimeLifecycleInstallBodySchema,
  RuntimeLifecycleStartResponseSchema,
  RuntimeLifecycleViewSchema,
  RuntimePairedBootstrapBodySchema,
  RuntimePairingIssueSchema,
  RuntimePairingStatusSchema,
  RuntimeSetupBodySchema,
  ToolchainSelectionSchema,
  ToolchainUpdateBodySchema,
  UpdateEnvironmentBodySchema,
} from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { Elysia, status, t } from 'elysia';

import { apiErrorStatus } from '../../../lib/api-error-status';
import { environmentUnavailableResponse } from '../../../lib/environment-unavailable';
import { createDiagnosticLogger } from '../../../lib/logger';
import { sseResponse } from '../../../lib/sse-stream';
import { requireAuth } from '../../../plugins/auth-middleware';
import type { EnvironmentService } from '../application/environment-service';
import {
  RuntimeLifecycleConflictError,
  type RuntimeLifecycleService,
  runtimeLifecycleService,
  RuntimeLifecycleUnavailableError,
} from '../application/runtime-lifecycle-service';
import {
  type RuntimePairingService,
  runtimePairingService,
} from '../application/runtime-pairing-service';
import { type ToolchainService, toolchainService } from '../application/toolchain-service';
import { EnvironmentServiceError } from '../domain/environment-error';

const environmentParams = t.Object({ id: EnvironmentIdSchema });
const runIdParams = t.Object({
  id: EnvironmentIdSchema,
  runId: t.String({ minLength: 1 }),
});

const logger = createDiagnosticLogger('environment-routes');

/**
 * The refusals `environmentError` can answer with, declared once for every route
 * that calls it. The helper's return type is the union of all of them, so a route
 * declaring fewer statuses would not type-check.
 *
 * Deliberately not `as const`: spread into a `response` map, a readonly object
 * makes Eden read the whole error channel as `unknown`.
 */
const ENVIRONMENT_ERRORS = {
  400: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  409: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  503: ApiErrorResponseSchema,
};

/**
 * Answers a service refusal. The body carries `message` and `reason` only; the
 * diagnostic stays in the hub log, so no producer can leak stderr or a path by
 * putting it in the wrong field.
 */
function environmentError(
  error: unknown,
  set: { headers?: Record<string, string | number | string[]> }
) {
  if (error instanceof EnvironmentServiceError) {
    if (error.diagnostic !== undefined) {
      logger.warn('service_refusal', {
        environmentId: error.environmentId,
        status: error.status,
        reason: error.reason,
        diagnostic: error.diagnostic,
      });
    }
    return apiErrorStatus(error.status, {
      error: error.message,
      ...(error.reason === undefined ? {} : { details: { reason: error.reason } }),
      code:
        error.status === 404
          ? ERROR_CODES.NOT_FOUND
          : error.status === 409
            ? ERROR_CODES.CONFLICT
            : error.status === 503
              ? ERROR_CODES.PROVIDER_ERROR
              : ERROR_CODES.VALIDATION,
    });
  }
  if (error instanceof RuntimeLifecycleUnavailableError) {
    return apiErrorStatus(error.status, {
      error: error.message,
      code:
        error.status === 404
          ? ERROR_CODES.NOT_FOUND
          : error.status === 409
            ? ERROR_CODES.CONFLICT
            : ERROR_CODES.VALIDATION,
    });
  }
  if (error instanceof RuntimeLifecycleConflictError) {
    return status(409, { error: error.message, code: ERROR_CODES.CONFLICT });
  }
  const unavailable = environmentUnavailableResponse(error, set);
  if (unavailable) return unavailable;
  throw error;
}

export function createEnvironmentEntityRoutes(
  service: EnvironmentService,
  pairing: RuntimePairingService = runtimePairingService,
  lifecycle: RuntimeLifecycleService = runtimeLifecycleService,
  toolchain: ToolchainService = toolchainService
) {
  // A Direct URL edit can commit its row before saving the token and dropping
  // the old connection. Do not start toolchain validation in that window.
  const pendingDefinitionEdits = new Map<string, number>();
  return (
    new Elysia()
      .use(requireAuth)
      .get(
        '/environments',
        {
          response: { 200: EnvironmentListSchema },
        },
        ({ user }) => service.list(user?.id ?? '')
      )
      .post(
        '/environments',
        {
          body: CreateEnvironmentBodySchema,
          response: { 201: EnvironmentSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ body, user, set }) => {
          try {
            set.status = 201;
            return await service.create(user?.id ?? '', body);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .get(
        '/environments/:id',
        {
          params: environmentParams,
          response: {
            200: EnvironmentSchema,
            404: ApiErrorResponseSchema,
          },
        },
        async ({ params, user, set }) => {
          const environment = await service.find(user?.id ?? '', params.id);
          if (environment) return environment;
          set.status = 404;
          return {
            error: `Environment "${params.id}" was not found.`,
            code: ERROR_CODES.NOT_FOUND,
          };
        }
      )
      .put(
        '/environments/:id',
        {
          params: environmentParams,
          body: UpdateEnvironmentBodySchema,
          response: { 200: EnvironmentSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, body, user, set }) => {
          const userId = user?.id ?? '';
          const key = JSON.stringify([userId, params.id]);
          const changesDefinition = body.config !== undefined || body.token !== undefined;
          if (changesDefinition) {
            pendingDefinitionEdits.set(key, (pendingDefinitionEdits.get(key) ?? 0) + 1);
          }
          try {
            return await service.update(userId, params.id, body);
          } catch (error) {
            return environmentError(error, set);
          } finally {
            if (changesDefinition) {
              const remaining = (pendingDefinitionEdits.get(key) ?? 1) - 1;
              if (remaining === 0) pendingDefinitionEdits.delete(key);
              else pendingDefinitionEdits.set(key, remaining);
            }
          }
        }
      )
      // `local` is a valid `:id` — the virtual environment has its own
      // toolchain row exactly as install runs key on it as a sentinel.
      .put(
        '/environments/:id/toolchain',
        {
          params: environmentParams,
          body: ToolchainUpdateBodySchema,
          response: { 200: ToolchainSelectionSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, body, user, set }) => {
          const userId = user?.id ?? '';
          try {
            return await toolchain.update(userId, params.id, body, () => {
              if (pendingDefinitionEdits.has(JSON.stringify([userId, params.id]))) {
                throw new EnvironmentServiceError(
                  `Environment "${params.id}" is being reconfigured.`,
                  409
                );
              }
            });
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .delete(
        '/environments/:id',
        {
          params: environmentParams,
          query: t.Object({
            removeRuntime: t.Optional(
              t.Union([t.Boolean(), t.Literal('true'), t.Literal('false')])
            ),
          }),
          response: { 200: t.Object({ success: t.Literal(true) }), ...ENVIRONMENT_ERRORS },
        },
        async ({ params, query, user, set }) => {
          try {
            await service.remove(user?.id ?? '', params.id, {
              removeRuntime: query.removeRuntime === true || query.removeRuntime === 'true',
            });
            return { success: true as const };
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .post(
        '/environments/:id/connect',
        {
          params: environmentParams,
          response: { 200: EnvironmentSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, user, set }) => {
          try {
            return await service.connect(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .post(
        '/environments/:id/disconnect',
        {
          params: environmentParams,
          response: { 200: EnvironmentSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, user, set }) => {
          try {
            return await service.disconnect(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .get(
        '/environments/:id/pairing',
        {
          params: environmentParams,
          response: { 200: RuntimePairingStatusSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, user, set }) => {
          try {
            return await pairing.status(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      // POST rather than PUT: each call mints a new secret and retires the
      // previous one, so replaying it is not the same as sending it once.
      .post(
        '/environments/:id/pairing',
        {
          params: environmentParams,
          response: { 201: RuntimePairingIssueSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, user, set }) => {
          try {
            set.status = 201;
            return await pairing.issue(user?.id ?? '', params.id);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .delete(
        '/environments/:id/pairing',
        {
          params: environmentParams,
          response: { 200: t.Object({ success: t.Literal(true) }), ...ENVIRONMENT_ERRORS },
        },
        async ({ params, user, set }) => {
          try {
            await pairing.revoke(user?.id ?? '', params.id);
            return { success: true as const };
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .get(
        '/environments/:id/runtime',
        {
          params: environmentParams,
          query: t.Object({
            slotBytes: t.Optional(t.Union([t.Boolean(), t.Literal('true'), t.Literal('false')])),
          }),
          response: { 200: RuntimeLifecycleViewSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, query, user, set }) => {
          try {
            return await lifecycle.getView(user?.id ?? '', params.id, {
              includeSlotBytes: query.slotBytes === true || query.slotBytes === 'true',
            });
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .post(
        '/environments/:id/runtime/install',
        {
          params: environmentParams,
          body: RuntimeLifecycleInstallBodySchema,
          response: { 200: RuntimeLifecycleStartResponseSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, body, user, set }) => {
          try {
            return await lifecycle.startInstall(user?.id ?? '', params.id, body);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .post(
        '/environments/:id/runtime/runs/:runId/cancel',
        {
          params: runIdParams,
          response: {
            200: RuntimeLifecycleCancelResponseSchema,
            404: ApiErrorResponseSchema,
          },
        },
        async ({ params, user, set }) => {
          const cancelled = await lifecycle.cancel(params.runId, user?.id ?? '');
          if (!cancelled) {
            set.status = 404;
            return { error: 'Runtime install run not found.', code: ERROR_CODES.NOT_FOUND };
          }
          return { runId: params.runId, cancellationRequested: true };
        }
      )
      .post(
        '/environments/:id/runtime/setup',
        {
          params: environmentParams,
          body: RuntimeSetupBodySchema,
          response: { 200: RuntimeLifecycleViewSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, body, user, set }) => {
          try {
            return await lifecycle.startSetup(user?.id ?? '', params.id, body);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      // The ssh credentials in this body are used for the duration of the run
      // and never stored: after it, the machine reaches the hub, not the other
      // way round. The pairing token it mints stays hub-side too — it goes
      // straight into the ssh channel's stdin rather than into this response.
      .post(
        '/environments/:id/runtime/bootstrap',
        {
          params: environmentParams,
          body: RuntimePairedBootstrapBodySchema,
          response: { 200: RuntimeLifecycleStartResponseSchema, ...ENVIRONMENT_ERRORS },
        },
        async ({ params, body, user, set }) => {
          try {
            return await lifecycle.startPairedBootstrap(user?.id ?? '', params.id, body);
          } catch (error) {
            return environmentError(error, set);
          }
        }
      )
      .get(
        '/environments/:id/runtime/runs/:runId/log',
        {
          params: runIdParams,
          response: {
            404: ApiErrorResponseSchema,
          },
        },
        async ({ params, user, set }) => {
          const source = await lifecycle.getRunStream(params.runId, user?.id ?? '');
          if (!source) {
            set.status = 404;
            return { error: 'Runtime install run not found.', code: ERROR_CODES.NOT_FOUND };
          }

          return sseResponse(source, 'Runtime install log stream failed.');
        }
      )
  );
}
