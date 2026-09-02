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
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import { Elysia, t } from 'elysia';
import { resolveGuardClientIp } from '../../../lib/client-ip';
import { getConfig } from '../../../lib/config';
import { ProfileMismatchError } from '../../../lib/profile-context';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  InstallBlockedError,
  InstallConflictError,
  InstallPreparationError,
  type InstallRequestContext,
  type InstallService,
  InstallUnavailableError,
  installService,
} from '../application/install-service';
import { RecipeInputError } from '../domain/recipe-input';
import { InstallerDownloadError } from '../infrastructure/installer-download';

const KEEPALIVE_INTERVAL_MS = 15_000;
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

function mapInstallError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse | ReturnType<typeof blockedResponse> | ReturnType<typeof unavailableResponse> {
  if (error instanceof InstallBlockedError) {
    set.status = 403;
    return blockedResponse(error);
  }
  if (error instanceof InstallUnavailableError) {
    set.status = 409;
    return unavailableResponse(error);
  }
  if (error instanceof InstallConflictError || error instanceof InstallPreparationError) {
    set.status = 409;
    return { error: error.message, code: ERROR_CODES.CONFLICT };
  }
  if (error instanceof RecipeInputError) {
    set.status = 422;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  if (error instanceof ProfileMismatchError) {
    set.status = 400;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  if (error instanceof InstallerDownloadError) {
    set.status = 502;
    return { error: error.message, code: ERROR_CODES.INTERNAL };
  }
  throw error;
}

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

export function createInstallRoutes(
  service: InstallService = installService,
  trustProxy: () => boolean = () => getConfig().security.trustProxy
) {
  return new Elysia()
    .use(requireAuth)
    .derive(({ request, server }) => {
      // The socket peer is not header-controlled, so it is the default. It is
      // not enough on its own: behind the documented nginx and Caddy setups the
      // peer is always the loopback proxy, and every remote browser would pass
      // a check that is supposed to mean "at this machine's keyboard". Where
      // the operator has trusted the proxy, the hop that proxy appended is the
      // stricter answer; where they have not, a forged header changes nothing.
      return {
        installPeerIp: resolveGuardClientIp(
          request.headers,
          server?.requestIP(request)?.address,
          trustProxy()
        ),
      };
    })
    .get(
      '/environments/install/recipes',
      {
        query: t.Object({ environmentId: t.Optional(EnvironmentIdSchema) }),
        response: { 200: t.Array(InstallRecipePreviewSchema) },
      },
      ({ user, installPeerIp, request, query }) =>
        service.listRecipes({
          ...requestContext({
            userId: user?.id ?? '',
            peerIp: installPeerIp,
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
      async ({ body, user, installPeerIp, request, set }) => {
        try {
          return await service.prepare(
            body,
            requestContext({
              userId: user?.id ?? '',
              peerIp: installPeerIp,
              request,
              includeSignal: true,
            })
          );
        } catch (error) {
          return mapInstallError(error, set);
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
        },
      },
      async ({ body, user, installPeerIp, request, set }) => {
        try {
          return await service.start(
            body,
            requestContext({
              userId: user?.id ?? '',
              peerIp: installPeerIp,
              request,
              includeSignal: true,
            })
          );
        } catch (error) {
          return mapInstallError(error, set);
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
      async ({ params, user, set }) => {
        const result = await service.cancel(params.runId, user?.id ?? '');
        if (result) return result;
        set.status = 404;
        return { error: 'Install run not found.', code: ERROR_CODES.NOT_FOUND };
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
      async ({ params, user, set }) => {
        const source = await service.getRunStream(params.runId, user?.id ?? '');
        if (!source) {
          set.status = 404;
          return { error: 'Install run not found.', code: ERROR_CODES.NOT_FOUND };
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
                  error: error instanceof Error ? error.message : 'Install log stream failed.',
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
    );
}
