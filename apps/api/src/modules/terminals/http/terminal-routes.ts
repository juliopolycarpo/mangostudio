import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import {
  TerminalAvailabilityQuerySchema,
  TerminalAvailabilitySchema,
  TerminalListQuerySchema,
  TerminalListResponseSchema,
  TerminalOpenBodySchema,
  TerminalRenameBodySchema,
  TerminalSessionResponseSchema,
} from '@mangostudio/shared/terminal';
import { Elysia, status, t } from 'elysia';

import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import {
  type TerminalSessionService,
  terminalSessionService,
} from '../application/terminal-session-service';
import {
  TerminalDisabledError,
  TerminalInvalidOpenError,
  TerminalLimitError,
  TerminalNotIsolatedError,
  TerminalSessionNotFoundError,
  TerminalUnavailableError,
} from '../domain/terminal-errors';

/** The pattern every other module error mapper follows: `mapMachineError` is the reference. */
function mapTerminalError(error: unknown) {
  if (error instanceof TerminalInvalidOpenError) {
    return status(400, { error: error.message, code: ERROR_CODES.VALIDATION });
  }
  if (error instanceof TerminalDisabledError) {
    return status(403, { error: error.message, code: ERROR_CODES.TERMINAL_DISABLED });
  }
  if (error instanceof TerminalLimitError) {
    return status(409, {
      error: error.message,
      code: ERROR_CODES.TERMINAL_LIMIT,
      details: { limit: String(error.limit) },
    });
  }
  if (error instanceof TerminalNotIsolatedError) {
    return status(403, { error: error.message, code: ERROR_CODES.TERMINAL_NOT_ISOLATED });
  }
  if (error instanceof TerminalUnavailableError) {
    return status(409, {
      error: error.message,
      code: ERROR_CODES.UNSUPPORTED,
      details: { reason: error.reason },
    });
  }
  if (error instanceof ChatNotFoundError || error instanceof TerminalSessionNotFoundError) {
    return status(404, { error: error.message, code: ERROR_CODES.NOT_FOUND });
  }
  throw error;
}

/** Every status `mapTerminalError` can answer; each route declares the same set. */
const TERMINAL_ERRORS = {
  400: ApiErrorResponseSchema,
  403: ApiErrorResponseSchema,
  404: ApiErrorResponseSchema,
  409: ApiErrorResponseSchema,
};

const idParams = t.Object({ id: t.String({ minLength: 1 }) });
const OkResponseSchema = t.Object({ ok: t.Literal(true) });

export function createTerminalRoutes(service: TerminalSessionService = terminalSessionService) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/terminals/availability',
      {
        query: TerminalAvailabilityQuerySchema,
        response: { 200: TerminalAvailabilitySchema },
      },
      ({ query, user }) => service.availability(user?.id ?? '', query.environmentId)
    )
    .get(
      '/terminals',
      {
        query: TerminalListQuerySchema,
        response: { 200: TerminalListResponseSchema },
      },
      async ({ query, user }) => {
        const userId = user?.id ?? '';
        await service.reconcile(userId);
        return { sessions: service.list(userId, query) };
      }
    )
    .post(
      '/terminals',
      {
        body: TerminalOpenBodySchema,
        response: {
          201: TerminalSessionResponseSchema,
          ...TERMINAL_ERRORS,
        },
      },
      async ({ body, request, set, user }) => {
        try {
          const session = await service.open(user?.id ?? '', body, request.signal);
          set.status = 201;
          return { session };
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            return status(409, {
              error: 'Terminal open canceled.',
              code: ERROR_CODES.UNSUPPORTED,
              details: { reason: 'disconnected' },
            });
          }
          return mapTerminalError(error);
        }
      }
    )
    .patch(
      '/terminals/:id',
      {
        params: idParams,
        body: TerminalRenameBodySchema,
        response: { 200: TerminalSessionResponseSchema, ...TERMINAL_ERRORS },
      },
      ({ params, body, user }) => {
        try {
          return { session: service.rename(user?.id ?? '', params.id, body) };
        } catch (error) {
          return mapTerminalError(error);
        }
      }
    )
    .delete(
      '/terminals/:id',
      {
        params: idParams,
        response: {
          200: OkResponseSchema,
          ...TERMINAL_ERRORS,
        },
      },
      async ({ params, user }) => {
        try {
          await service.close(user?.id ?? '', params.id);
          return { ok: true as const };
        } catch (error) {
          return mapTerminalError(error);
        }
      }
    );
}

export const terminalRoutes = createTerminalRoutes();
