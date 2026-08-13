import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type LibraryDivergenceAck,
  LibraryDivergenceAckListSchema,
  type LibraryDivergenceAckRequest,
  LibraryDivergenceAckRequestSchema,
  LibraryDivergenceAckSchema,
  type PropagationApply,
  type PropagationApplyRequest,
  PropagationApplyRequestSchema,
  PropagationApplySchema,
  PropagationBackupPurgeQuerySchema,
  PropagationBackupPurgeRequestSchema,
  type PropagationBackupUsage,
  PropagationBackupUsageSchema,
  type PropagationPreview,
  type PropagationPreviewRequest,
  PropagationPreviewRequestSchema,
  PropagationPreviewSchema,
  type PropagationUndo,
  PropagationUndoRequestSchema,
  PropagationUndoSchema,
  parseResourceKey,
} from '@mangostudio/shared/library';
import { Elysia, t } from 'elysia';
import { ProfileMismatchError } from '../../../lib/profile-context';
import { requireAuth } from '../../../plugins/auth-middleware';
import { describeBackupUsage, purgeEnvironmentBackup } from '../application/backup-inventory';
import {
  acknowledgeDivergence,
  forgetDivergenceAck,
  listDivergenceAcks,
} from '../application/conflict-resolution';
import { applyLibraryPropagation, undoLibraryPropagation } from '../application/propagation-apply';
import { previewLibraryPropagation } from '../application/propagation-preview';
import { LibraryRequestError } from '../domain/library-request-error';
import { assertBackupId } from '../infrastructure/backup-store';
import { handleLibraryError } from './library-error';

export interface PropagationRouteService {
  preview(userId: string, request: PropagationPreviewRequest): Promise<PropagationPreview>;
  apply(userId: string, request: PropagationApplyRequest): Promise<PropagationApply>;
  undo(userId: string, backupId: string, environmentId: string): Promise<PropagationUndo>;
  backupUsage(userId: string): Promise<PropagationBackupUsage>;
  purgeBackup(userId: string, environmentId: string, backupId: string): Promise<void>;
  listAcks(userId: string): Promise<LibraryDivergenceAck[]>;
  acknowledge(userId: string, request: LibraryDivergenceAckRequest): Promise<LibraryDivergenceAck>;
  forgetAck(userId: string, resourceKey: string): Promise<void>;
}

const defaultPropagationRouteService: PropagationRouteService = {
  preview: (userId, request) => previewLibraryPropagation(userId, request),
  apply: (userId, request) => applyLibraryPropagation(userId, request),
  undo: (userId, backupId, environmentId) =>
    undoLibraryPropagation(backupId, { environmentId }, userId),
  backupUsage: (userId) => describeBackupUsage(userId),
  purgeBackup: (userId, environmentId, backupId) =>
    purgeEnvironmentBackup(userId, environmentId, backupId),
  listAcks: (userId) => listDivergenceAcks(userId),
  acknowledge: (userId, request) => acknowledgeDivergence(userId, request),
  forgetAck: (userId, resourceKey) => forgetDivergenceAck(userId, resourceKey),
};

const ERROR_CODE_BY_STATUS = {
  400: ERROR_CODES.VALIDATION,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  422: ERROR_CODES.VALIDATION,
} as const;

function mapPropagationError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof LibraryRequestError) {
    set.status = error.status;
    return { error: error.message, code: error.code ?? ERROR_CODE_BY_STATUS[error.status] };
  }
  if (error instanceof ProfileMismatchError) {
    set.status = 400;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  return handleLibraryError(error, set, '[library]', 'Unexpected library propagation error.');
}

function invalidResourceKey(set: { status?: number | string }): ApiErrorResponse {
  set.status = 422;
  return { error: 'Invalid library resource key.', code: ERROR_CODES.VALIDATION };
}

export function createPropagationRoutes(
  service: PropagationRouteService = defaultPropagationRouteService
) {
  return new Elysia()
    .use(requireAuth)
    .post(
      '/library/propagate/preview',
      {
        body: PropagationPreviewRequestSchema,
        response: {
          200: PropagationPreviewSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, set, user }): Promise<PropagationPreview | ApiErrorResponse> => {
        try {
          return await service.preview(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .post(
      '/library/propagate/apply',
      {
        body: PropagationApplyRequestSchema,
        response: {
          200: PropagationApplySchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          // The preview no longer describes what is on disk. Re-preview rather
          // than writing over a change the user made in the meantime.
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          // The write engine runs on the runtime, so an unreachable runtime is
          // the same 503 the discovery and settings routes already return.
          503: ApiErrorResponseSchema,
        },
      },
      async ({ body, set, user }): Promise<PropagationApply | ApiErrorResponse> => {
        try {
          return await service.apply(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .post(
      '/library/propagate/undo',
      {
        body: PropagationUndoRequestSchema,
        response: {
          200: PropagationUndoSchema,
          404: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          // Undo replays the backup set on the runtime, so an unreachable
          // runtime is a 503 rather than an internal error.
          503: ApiErrorResponseSchema,
        },
      },
      async ({ body, set, user }): Promise<PropagationUndo | ApiErrorResponse> => {
        try {
          return await service.undo(
            user?.id ?? '',
            body.backupId,
            body.environmentId ?? LOCAL_ENVIRONMENT_ID
          );
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .get(
      '/library/propagate/backups',
      {
        response: {
          200: PropagationBackupUsageSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ set, user }): Promise<PropagationBackupUsage | ApiErrorResponse> => {
        try {
          return await service.backupUsage(user?.id ?? '');
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .delete(
      '/library/propagate/backups/:backupId',
      {
        params: PropagationBackupPurgeRequestSchema,
        query: PropagationBackupPurgeQuerySchema,
        response: {
          204: t.Void(),
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
          503: ApiErrorResponseSchema,
        },
      },
      async ({ params, query, set, user }): Promise<undefined | ApiErrorResponse> => {
        // Pinning keeps a set holding someone's only copy of a resource out of
        // every automatic eviction path, which only works if there is an
        // explicit way to say "yes, really, let it go". This is it.
        try {
          assertBackupId(params.backupId);
        } catch {
          set.status = 422;
          return { error: 'Invalid library backup id.', code: ERROR_CODES.VALIDATION };
        }
        try {
          // Idempotent: purging a set that is already gone is the state the
          // caller asked for, not an error. Unreachable is not idempotent —
          // the bytes are still there, so it stays a 503.
          await service.purgeBackup(
            user?.id ?? '',
            query.environmentId ?? LOCAL_ENVIRONMENT_ID,
            params.backupId
          );
          set.status = 204;
          return undefined;
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .get(
      '/library/divergence/acks',
      {
        response: {
          200: LibraryDivergenceAckListSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ set, user }): Promise<LibraryDivergenceAck[] | ApiErrorResponse> => {
        try {
          return await service.listAcks(user?.id ?? '');
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .post(
      '/library/divergence/acks',
      {
        body: LibraryDivergenceAckRequestSchema,
        response: {
          200: LibraryDivergenceAckSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          // The reviewed hashes no longer match disk, so the acknowledgement
          // would cover a divergence the user has not actually seen.
          409: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ body, set, user }): Promise<LibraryDivergenceAck | ApiErrorResponse> => {
        try {
          return await service.acknowledge(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    )
    .delete(
      '/library/divergence/acks/:key',
      {
        params: t.Object({ key: t.String() }),
        response: {
          204: t.Void(),
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      },
      async ({ params, set, user }): Promise<undefined | ApiErrorResponse> => {
        if (!parseResourceKey(params.key)) return invalidResourceKey(set);
        try {
          // Idempotent: forgetting an acknowledgement that is not there is the
          // state the caller asked for, not an error.
          await service.forgetAck(user?.id ?? '', params.key);
          set.status = 204;
          return undefined;
        } catch (error) {
          return mapPropagationError(error, set);
        }
      }
    );
}

export const propagationRoutes = createPropagationRoutes();
