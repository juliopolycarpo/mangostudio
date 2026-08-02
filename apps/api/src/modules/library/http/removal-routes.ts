/**
 * Removal's own preview/apply pair.
 *
 * Deliberately not an `operation: 'delete'` flag on the propagation routes.
 * Propagation decides which content wins; removal decides which copies go, and
 * one endpoint meaning both is one where the destructive request shares a
 * schema — and a client's default — with the safe one.
 *
 * There is no removal undo route: removal backups share propagation's
 * `backupId` namespace, so `POST /library/propagate/undo` restores either kind.
 */

import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type RemovalApply,
  type RemovalApplyRequest,
  RemovalApplyRequestSchema,
  RemovalApplySchema,
  type RemovalPreview,
  type RemovalPreviewRequest,
  RemovalPreviewRequestSchema,
  RemovalPreviewSchema,
} from '@mangostudio/shared/library';
import { Elysia } from 'elysia';
import { ProfileMismatchError } from '../../../lib/profile-context';
import { requireAuth } from '../../../plugins/auth-middleware';
import { applyLibraryRemoval } from '../application/removal-apply';
import { previewLibraryRemoval } from '../application/removal-preview';
import { LibraryRequestError } from '../domain/library-request-error';
import { handleLibraryError } from './library-error';

export interface RemovalRouteService {
  preview(userId: string, request: RemovalPreviewRequest): Promise<RemovalPreview>;
  apply(userId: string, request: RemovalApplyRequest): Promise<RemovalApply>;
}

const defaultRemovalRouteService: RemovalRouteService = {
  preview: (userId, request) => previewLibraryRemoval(userId, request),
  apply: (userId, request) => applyLibraryRemoval(userId, request),
};

const ERROR_CODE_BY_STATUS = {
  400: ERROR_CODES.VALIDATION,
  404: ERROR_CODES.NOT_FOUND,
  409: ERROR_CODES.CONFLICT,
  422: ERROR_CODES.VALIDATION,
} as const;

function mapRemovalError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof LibraryRequestError) {
    set.status = error.status;
    return { error: error.message, code: error.code ?? ERROR_CODE_BY_STATUS[error.status] };
  }
  if (error instanceof ProfileMismatchError) {
    set.status = 400;
    return { error: error.message, code: ERROR_CODES.VALIDATION };
  }
  return handleLibraryError(error, set, '[library]', 'Unexpected library removal error.');
}

export function createRemovalRoutes(service: RemovalRouteService = defaultRemovalRouteService) {
  return new Elysia()
    .use(requireAuth)
    .post(
      '/library/removal/preview',
      async ({ body, set, user }): Promise<RemovalPreview | ApiErrorResponse> => {
        try {
          return await service.preview(user?.id ?? '', body);
        } catch (error) {
          return mapRemovalError(error, set);
        }
      },
      {
        body: RemovalPreviewRequestSchema,
        response: {
          200: RemovalPreviewSchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    )
    .post(
      '/library/removal/apply',
      async ({ body, set, user }): Promise<RemovalApply | ApiErrorResponse> => {
        try {
          return await service.apply(user?.id ?? '', body);
        } catch (error) {
          return mapRemovalError(error, set);
        }
      },
      {
        body: RemovalApplyRequestSchema,
        response: {
          200: RemovalApplySchema,
          400: ApiErrorResponseSchema,
          404: ApiErrorResponseSchema,
          // The preview no longer describes what is on disk — including, quite
          // possibly, an edit to the very copy this request would delete.
          409: ApiErrorResponseSchema,
          // Also `LAST_COPY_UNACKNOWLEDGED`: the request would leave no copy of
          // a resource anywhere and did not say so out loud.
          422: ApiErrorResponseSchema,
          500: ApiErrorResponseSchema,
        },
      }
    );
}

export const removalRoutes = createRemovalRoutes();
