/**
 * The two calls behind "continue a session from your terminal".
 *
 * `GET /external-agents/sessions` asks one machine which vendor conversations
 * exist on it. `POST /chats/adopt-external-session` points a new chat at one of
 * them. Both delegate every decision to the application service — ownership,
 * the isolation attestation, whether the adapter can list at all, the re-read
 * and the lease all live there, because a second copy of any of those here
 * would be a weaker path to the same vendor.
 *
 * What these functions own is the mapping from a refusal to a status code, and
 * that mapping is deliberately coarse in one place: an environment that is
 * offline, one that was deleted and one that belongs to somebody else all
 * answer the same way, so the response cannot be used to enumerate other
 * people's machines.
 */

import { ChatSchema } from '@mangostudio/shared/chat';
import { EnvironmentIdSchema, LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import {
  EXTERNAL_NATIVE_SESSION_PAGE_LIMIT,
  ExternalNativeSessionListResponseSchema,
  ExternalSessionAdoptionRequestSchema,
  isExternalAgentTargetId,
  schemaMaxLengthFor,
} from '@mangostudio/shared/external-agents';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  type ExternalNativeSessionRefusalCode,
  type ExternalNativeSessionService,
  externalNativeSessionService,
} from '../application/external-native-sessions';

const SessionQuerySchema = t.Object({
  environmentId: t.Optional(EnvironmentIdSchema),
  targetId: t.String({ minLength: 1, maxLength: 64 }),
  /** Filter to one folder. The picker defaults to the chat's own. */
  workspacePath: t.Optional(t.String({ minLength: 1, maxLength: 4_096 })),
  cursor: t.Optional(t.String({ minLength: 1, maxLength: schemaMaxLengthFor('vendorId') })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: EXTERNAL_NATIVE_SESSION_PAGE_LIMIT })),
});

const AdoptResponseSchema = t.Object({ chat: ChatSchema });

const UNAUTHENTICATED = {
  error: 'Authentication required.',
  code: ERROR_CODES.UNAUTHORIZED,
} as const;

/**
 * How a refusal reads over HTTP.
 *
 * `isolation-unproven` is a 403 rather than a 409: it is a standing property of
 * the machine, not a race the caller can retry out of. `stale` and `held` are
 * both 409s, but they carry different error codes — a stale row is fixed by
 * refreshing the list, while a held one is fixed by using the chat that already
 * has the session, and a client that could not tell them apart would offer the
 * wrong remedy for one of them.
 */
function statusFor(code: ExternalNativeSessionRefusalCode): number {
  switch (code) {
    case 'unreachable':
      return 503;
    case 'isolation-unproven':
      return 403;
    case 'unsupported':
    case 'unavailable':
    case 'no-workspace':
      return 400;
    case 'stale':
    case 'held':
      return 409;
  }
}

function errorCodeFor(code: ExternalNativeSessionRefusalCode): string {
  switch (code) {
    case 'unreachable':
      return ERROR_CODES.PROVIDER_ERROR;
    case 'isolation-unproven':
      return ERROR_CODES.PERMISSION_DENIED;
    case 'stale':
      return ERROR_CODES.CONFLICT;
    case 'held':
      return ERROR_CODES.EXTERNAL_SESSION_HELD;
    default:
      return ERROR_CODES.VALIDATION;
  }
}

export function createExternalSessionRoutes(
  sessions: ExternalNativeSessionService = externalNativeSessionService
) {
  return new Elysia()
    .use(requireAuth)
    .get(
      '/external-agents/sessions',
      async ({ query, user, set }) => {
        const userId = user?.id;
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        if (!isExternalAgentTargetId(query.targetId)) {
          set.status = 404;
          return { error: 'Unknown external agent.', code: ERROR_CODES.NOT_FOUND };
        }
        const environmentId = query.environmentId ?? LOCAL_ENVIRONMENT_ID;
        const listing = await sessions.list({
          userId,
          environmentId,
          targetId: query.targetId,
          ...(query.workspacePath ? { workspacePath: query.workspacePath } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.limit === undefined ? {} : { limit: query.limit }),
        });
        if (!listing.ok) {
          set.status = statusFor(listing.code);
          return { error: listing.message, code: errorCodeFor(listing.code) };
        }
        return {
          environmentId,
          sessions: [...listing.sessions],
          ...(listing.nextCursor ? { nextCursor: listing.nextCursor } : {}),
        };
      },
      {
        query: SessionQuerySchema,
        response: {
          200: ExternalNativeSessionListResponseSchema,
          400: ApiErrorResponseSchema,
          401: ApiErrorResponseSchema,
          403: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/chats/adopt-external-session',
      async ({ body, user, set }) => {
        const userId = user?.id;
        if (!userId) {
          set.status = 401;
          return UNAUTHENTICATED;
        }
        const adopted = await sessions.adopt({
          userId,
          environmentId: body.environmentId,
          session: body.session,
        });
        if (!adopted.ok) {
          set.status = statusFor(adopted.code);
          return { error: adopted.message, code: errorCodeFor(adopted.code) };
        }
        set.status = 201;
        return { chat: adopted.chat };
      },
      {
        body: ExternalSessionAdoptionRequestSchema,
        response: {
          201: AdoptResponseSchema,
          400: ApiErrorResponseSchema,
          401: ApiErrorResponseSchema,
          403: ApiErrorResponseSchema,
          409: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      }
    );
}

export const externalSessionRoutes = createExternalSessionRoutes();
