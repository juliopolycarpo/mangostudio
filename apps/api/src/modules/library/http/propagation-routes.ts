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
import {
  acknowledgeDivergence,
  forgetDivergenceAck,
  listDivergenceAcks,
} from '../application/conflict-resolution';
import {
  applyLibraryPropagation,
  describeBackupUsage,
  undoLibraryPropagation,
} from '../application/propagation-apply';
import { previewLibraryPropagation } from '../application/propagation-preview';
import { PropagationRequestError } from '../domain/propagation-error';

export interface PropagationRouteService {
  preview(userId: string, request: PropagationPreviewRequest): Promise<PropagationPreview>;
  apply(userId: string, request: PropagationApplyRequest): Promise<PropagationApply>;
  undo(userId: string, backupId: string): Promise<PropagationUndo>;
  backupUsage(): Promise<PropagationBackupUsage>;
  listAcks(userId: string): Promise<LibraryDivergenceAck[]>;
  acknowledge(userId: string, request: LibraryDivergenceAckRequest): Promise<LibraryDivergenceAck>;
  forgetAck(userId: string, resourceKey: string): Promise<void>;
}

const defaultPropagationRouteService: PropagationRouteService = {
  preview: (userId, request) => previewLibraryPropagation(userId, request),
  apply: (userId, request) => applyLibraryPropagation(userId, request),
  undo: (_userId, backupId) => undoLibraryPropagation(backupId),
  backupUsage: () => describeBackupUsage(),
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
  if (error instanceof PropagationRequestError) {
    set.status = error.status;
    return { error: error.message, code: ERROR_CODE_BY_STATUS[error.status] };
  }
  if (error instanceof ProfileMismatchError) {
    set.status = 400;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  console.error('[library] Unexpected propagation error:', error);
  set.status = 500;
  return { error: 'Unexpected library propagation error.', code: ERROR_CODES.INTERNAL };
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
      async ({ body, set, user }): Promise<PropagationPreview | ApiErrorResponse> => {
        try {
          return await service.preview(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
      {
        body: PropagationPreviewRequestSchema,
        response: {
          200: PropagationPreviewSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/library/propagate/apply',
      async ({ body, set, user }): Promise<PropagationApply | ApiErrorResponse> => {
        try {
          return await service.apply(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
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
        },
      }
    )
    .post(
      '/library/propagate/undo',
      async ({ body, set, user }): Promise<PropagationUndo | ApiErrorResponse> => {
        try {
          return await service.undo(user?.id ?? '', body.backupId);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
      {
        body: PropagationUndoRequestSchema,
        response: {
          200: PropagationUndoSchema,
          404: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/propagate/backups',
      async ({ set }): Promise<PropagationBackupUsage | ApiErrorResponse> => {
        try {
          return await service.backupUsage();
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
      {
        response: {
          200: PropagationBackupUsageSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .get(
      '/library/divergence/acks',
      async ({ set, user }): Promise<LibraryDivergenceAck[] | ApiErrorResponse> => {
        try {
          return await service.listAcks(user?.id ?? '');
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
      {
        response: {
          200: LibraryDivergenceAckListSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/library/divergence/acks',
      async ({ body, set, user }): Promise<LibraryDivergenceAck | ApiErrorResponse> => {
        try {
          return await service.acknowledge(user?.id ?? '', body);
        } catch (error) {
          return mapPropagationError(error, set);
        }
      },
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
      }
    )
    .delete(
      '/library/divergence/acks/:key',
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
      },
      {
        params: t.Object({ key: t.String() }),
        response: {
          204: t.Void(),
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    );
}

export const propagationRoutes = createPropagationRoutes();
