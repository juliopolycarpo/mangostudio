import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  TerminalAvailabilityQuerySchema,
  TerminalAvailabilitySchema,
  TerminalListQuerySchema,
  TerminalListResponseSchema,
  TerminalOpenBodySchema,
  TerminalRenameBodySchema,
  TerminalSessionResponseSchema,
} from '@mangostudio/shared/terminal';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import {
  type TerminalSessionService,
  terminalSessionService,
} from '../application/terminal-session-service';
import {
  TerminalDisabledError,
  TerminalLimitError,
  TerminalNotIsolatedError,
  TerminalSessionNotFoundError,
  TerminalUnavailableError,
} from '../domain/terminal-errors';

/** The pattern every other module error mapper follows: `mapMachineError` is the reference. */
function mapTerminalError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof TerminalDisabledError) {
    set.status = 403;
    return { error: error.message, code: ERROR_CODES.TERMINAL_DISABLED };
  }
  if (error instanceof TerminalLimitError) {
    set.status = 409;
    return {
      error: error.message,
      code: ERROR_CODES.TERMINAL_LIMIT,
      details: { limit: String(error.limit) },
    };
  }
  if (error instanceof TerminalNotIsolatedError) {
    set.status = 403;
    return { error: error.message, code: ERROR_CODES.TERMINAL_NOT_ISOLATED };
  }
  if (error instanceof TerminalUnavailableError) {
    set.status = 409;
    return {
      error: error.message,
      code: ERROR_CODES.UNSUPPORTED,
      details: { reason: error.reason },
    };
  }
  if (error instanceof ChatNotFoundError || error instanceof TerminalSessionNotFoundError) {
    set.status = 404;
    return { error: error.message, code: ERROR_CODES.NOT_FOUND };
  }
  throw error;
}

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
      ({ query, user }) => ({ sessions: service.list(user?.id ?? '', query) })
    )
    .post(
      '/terminals',
      {
        body: TerminalOpenBodySchema,
        response: {
          201: TerminalSessionResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
        },
      },
      async ({ body, set, user }) => {
        try {
          const session = await service.open(user?.id ?? '', body);
          set.status = 201;
          return { session };
        } catch (error) {
          return mapTerminalError(error, set);
        }
      }
    )
    .patch(
      '/terminals/:id',
      {
        params: idParams,
        body: TerminalRenameBodySchema,
        response: { 200: TerminalSessionResponseSchema, 404: ApiErrorResponseSchema },
      },
      ({ params, body, set, user }) => {
        try {
          return { session: service.rename(user?.id ?? '', params.id, body) };
        } catch (error) {
          return mapTerminalError(error, set);
        }
      }
    )
    .delete(
      '/terminals/:id',
      {
        params: idParams,
        response: { 200: OkResponseSchema, 404: ApiErrorResponseSchema },
      },
      async ({ params, set, user }) => {
        try {
          await service.close(user?.id ?? '', params.id);
          return { ok: true as const };
        } catch (error) {
          return mapTerminalError(error, set);
        }
      }
    );
}

export const terminalRoutes = createTerminalRoutes();
