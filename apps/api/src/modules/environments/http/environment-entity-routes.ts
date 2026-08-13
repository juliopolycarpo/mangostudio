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
  UpdateEnvironmentBodySchema,
} from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import type { EnvironmentService } from '../application/environment-service';
import {
  RuntimeLifecycleConflictError,
  type RuntimeLifecycleService,
  RuntimeLifecycleUnavailableError,
  runtimeLifecycleService,
} from '../application/runtime-lifecycle-service';
import {
  type RuntimePairingService,
  runtimePairingService,
} from '../application/runtime-pairing-service';
import { EnvironmentServiceError } from '../domain/environment-error';

const environmentParams = t.Object({ id: EnvironmentIdSchema });
const runIdParams = t.Object({
  id: EnvironmentIdSchema,
  runId: t.String({ minLength: 1 }),
});

const KEEPALIVE_INTERVAL_MS = 15_000;
const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

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
  if (error instanceof RuntimeLifecycleUnavailableError) {
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
  if (error instanceof RuntimeLifecycleConflictError) {
    set.status = 409;
    return { error: error.message, code: ERROR_CODES.CONFLICT };
  }
  throw error;
}

export function createEnvironmentEntityRoutes(
  service: EnvironmentService,
  pairing: RuntimePairingService = runtimePairingService,
  lifecycle: RuntimeLifecycleService = runtimeLifecycleService
) {
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
          response: {
            201: EnvironmentSchema,
            400: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
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
          response: {
            200: EnvironmentSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
        },
        async ({ params, body, user, set }) => {
          try {
            return await service.update(user?.id ?? '', params.id, body);
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
          response: {
            200: t.Object({ success: t.Literal(true) }),
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
          },
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
          response: {
            200: EnvironmentSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            200: EnvironmentSchema,
            404: ApiErrorResponseSchema,
          },
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
          response: {
            200: RuntimePairingStatusSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            201: RuntimePairingIssueSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            200: t.Object({ success: t.Literal(true) }),
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            200: RuntimeLifecycleViewSchema,
            404: ApiErrorResponseSchema,
          },
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
          response: {
            200: RuntimeLifecycleStartResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            200: RuntimeLifecycleViewSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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
          response: {
            200: RuntimeLifecycleStartResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
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

          const iterator = source[Symbol.asyncIterator]();
          let disconnected = false;
          const stream = new ReadableStream({
            async start(controller) {
              const heartbeat = setInterval(() => {
                try {
                  controller.enqueue(KEEPALIVE_BYTES);
                } catch {
                  // The client may already have disconnected.
                }
              }, KEEPALIVE_INTERVAL_MS);
              try {
                while (!disconnected) {
                  const next = await iterator.next();
                  if (next.done) break;
                  controller.enqueue(sseEvent(next.value));
                }
              } catch (error) {
                if (!disconnected) {
                  const event: SSEErrorEvent = {
                    type: 'error',
                    error:
                      error instanceof Error ? error.message : 'Runtime install log stream failed.',
                    code: ERROR_CODES.INTERNAL,
                    done: true,
                  };
                  controller.enqueue(sseEvent(event));
                }
              } finally {
                clearInterval(heartbeat);
                try {
                  controller.close();
                } catch {
                  // The browser may have cancelled the stream.
                }
              }
            },
            async cancel() {
              disconnected = true;
              await iterator.return?.();
            },
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
        }
      )
  );
}
