import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type PropagationPreview,
  type PropagationPreviewRequest,
  PropagationPreviewRequestSchema,
  PropagationPreviewSchema,
} from '@mangostudio/shared/library';
import { Elysia } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  PropagationRequestError,
  previewLibraryPropagation,
} from '../application/propagation-preview';

export interface PropagationRouteService {
  preview(userId: string, request: PropagationPreviewRequest): Promise<PropagationPreview>;
}

const defaultPropagationRouteService: PropagationRouteService = {
  preview: (userId, request) => previewLibraryPropagation(userId, request),
};

function mapPropagationError(error: unknown, set: { status?: number | string }): ApiErrorResponse {
  if (error instanceof PropagationRequestError) {
    set.status = error.status;
    return {
      error: error.message,
      code: error.status === 404 ? ERROR_CODES.NOT_FOUND : ERROR_CODES.VALIDATION,
    };
  }
  console.error('[library] Unexpected propagation error:', error);
  set.status = 500;
  return { error: 'Unexpected library propagation error.', code: ERROR_CODES.INTERNAL };
}

export function createPropagationRoutes(
  service: PropagationRouteService = defaultPropagationRouteService
) {
  return new Elysia().use(requireAuth).post(
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
        404: ApiErrorResponseSchema,
        422: ApiErrorResponseSchema,
        500: ApiErrorResponseSchema,
      },
    }
  );
}

export const propagationRoutes = createPropagationRoutes();
