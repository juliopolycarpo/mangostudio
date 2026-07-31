import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  SubjectKeySchema,
  TOOL_IMAGE_MAX_BYTES,
  type ToolIdentityListResponse,
  ToolIdentityListResponseSchema,
  type ToolIdentityUpdateResponse,
  ToolIdentityUpdateResponseSchema,
  ToolIdentityUpdateSchema,
} from '@mangostudio/shared/tool-identity';
import { Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  listToolIdentities,
  readToolIdentityImage,
  resetToolIdentity,
  updateToolIdentity,
  uploadToolIdentityImage,
} from '../application/tool-identity-service';
import { ToolIdentityError } from '../application/tool-subject';

function handleToolIdentityError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof ToolIdentityError) {
    set.status = error.status;
    return { error: error.message, code: error.code };
  }

  console.error('[tool-identity] Unexpected tool identity error');
  set.status = 500;
  return { error: 'Unexpected tool identity error.', code: ERROR_CODES.INTERNAL };
}

const errorResponses = {
  401: ApiErrorResponseSchema,
  422: ApiErrorResponseSchema,
  500: ApiErrorResponseSchema,
} as const;

const subjectKeyParams = t.Object({ subjectKey: SubjectKeySchema });

/**
 * An avatar changes only when its owner changes it, but it is fetched on every
 * page that draws the tool. Revalidation keeps the round trip cheap without
 * letting a replaced image linger; the client also carries the identity's
 * `updatedAt` in the query string, which is what actually retires the old copy.
 */
const IMAGE_CACHE_CONTROL = 'private, max-age=0, must-revalidate';

export const toolIdentityRoutes = new Elysia().use(requireAuth).group('/tool-identities', (app) =>
  app
    .get(
      '/',
      async ({ set, user }): Promise<ToolIdentityListResponse | ApiErrorResponse> => {
        try {
          return await listToolIdentities(getDb(), user?.id ?? '');
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        response: {
          200: ToolIdentityListResponseSchema,
          ...errorResponses,
        },
      }
    )

    .put(
      '/:subjectKey',
      async ({
        body,
        params,
        set,
        user,
      }): Promise<ToolIdentityUpdateResponse | ApiErrorResponse> => {
        try {
          const identity = await updateToolIdentity(
            getDb(),
            user?.id ?? '',
            params.subjectKey,
            body
          );
          return { identity };
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        params: subjectKeyParams,
        body: ToolIdentityUpdateSchema,
        response: {
          200: ToolIdentityUpdateResponseSchema,
          ...errorResponses,
        },
      }
    )

    /**
     * Uploads an avatar image.
     *
     * The declared type is a first filter only — `uploadToolIdentityImage`
     * decides from the bytes. SVG is refused there and must stay refused: it is
     * markup that can carry script, and this file is later served from our own
     * origin, where that script would run with the viewer's session.
     */
    .post(
      '/:subjectKey/image',
      async ({
        body,
        params,
        set,
        user,
      }): Promise<ToolIdentityUpdateResponse | ApiErrorResponse> => {
        try {
          const identity = await uploadToolIdentityImage(
            getDb(),
            user?.id ?? '',
            params.subjectKey,
            body.image
          );
          return { identity };
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        params: subjectKeyParams,
        body: t.Object({
          // No `type` here on purpose. Elysia would reject the bytes with a
          // generic schema error, and the type is exactly the thing worth
          // explaining: an SVG has to come back with the reason it cannot be
          // accepted, not a shrug. `uploadToolIdentityImage` decides, and it
          // does so from the bytes. The size bound stays, since that one is
          // worth enforcing before the body is buffered.
          image: t.File({ maxSize: TOOL_IMAGE_MAX_BYTES }),
        }),
        response: {
          200: ToolIdentityUpdateResponseSchema,
          ...errorResponses,
        },
      }
    )

    /**
     * Serves a stored avatar to its owner.
     *
     * The type is the one recorded when the bytes were validated, and `nosniff`
     * is what makes pinning it meaningful: together they are the reason a file a
     * user uploaded cannot be talked into executing as something else.
     */
    .get(
      '/:subjectKey/image',
      async ({ params, set, user }) => {
        try {
          const image = await readToolIdentityImage(getDb(), user?.id ?? '', params.subjectKey);
          if (!image) {
            set.status = 404;
            return { error: 'No stored image for this tool.', code: ERROR_CODES.NOT_FOUND };
          }

          set.headers['Content-Type'] = image.mimeType;
          set.headers['X-Content-Type-Options'] = 'nosniff';
          set.headers['Cache-Control'] = IMAGE_CACHE_CONTROL;
          set.headers.ETag = `"${image.updatedAt}"`;
          return image.body;
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      { params: subjectKeyParams }
    )

    .delete(
      '/:subjectKey',
      async ({ params, set, user }): Promise<undefined | ApiErrorResponse> => {
        try {
          await resetToolIdentity(getDb(), user?.id ?? '', params.subjectKey);
          set.status = 204;
          return undefined;
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      },
      {
        params: subjectKeyParams,
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      }
    )
);
