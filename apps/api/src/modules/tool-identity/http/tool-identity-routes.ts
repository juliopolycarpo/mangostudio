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
 * The client asks for an avatar at `?v=<updatedAt>`, so a given address holds
 * one set of bytes for good: replacing the image moves the identity's
 * `updatedAt` and therefore asks for a different URL. That makes the copy the
 * browser already has safe to reuse without a round trip, which matters because
 * an avatar is fetched on every page that draws its tool.
 *
 * `private` because the bytes are behind the owner's session and no shared
 * cache may keep them.
 */
const IMAGE_CACHE_CONTROL = 'private, max-age=31536000, immutable';

/**
 * `If-None-Match` carries a list, and a cache is allowed to weaken a tag it
 * stored. Both are handled here rather than by comparing the header whole.
 */
function matchesEtag(header: string | null, etag: string): boolean {
  if (!header) return false;
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === etag);
}

export const toolIdentityRoutes = new Elysia().use(requireAuth).group('/tool-identities', (app) =>
  app
    .get(
      '/',
      {
        response: {
          200: ToolIdentityListResponseSchema,
          ...errorResponses,
        },
      },
      async ({ set, user }): Promise<ToolIdentityListResponse | ApiErrorResponse> => {
        try {
          return await listToolIdentities(getDb(), user?.id ?? '');
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      }
    )

    .put(
      '/:subjectKey',
      {
        params: subjectKeyParams,
        body: ToolIdentityUpdateSchema,
        response: {
          200: ToolIdentityUpdateResponseSchema,
          ...errorResponses,
        },
      },
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
      },
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
      { params: subjectKeyParams },
      async ({ params, request, set, user }) => {
        try {
          const image = await readToolIdentityImage(getDb(), user?.id ?? '', params.subjectKey);
          if (!image) {
            set.status = 404;
            return { error: 'No stored image for this tool.', code: ERROR_CODES.NOT_FOUND };
          }

          const etag = `"${image.updatedAt}"`;
          set.headers['X-Content-Type-Options'] = 'nosniff';
          set.headers['Cache-Control'] = IMAGE_CACHE_CONTROL;
          set.headers.ETag = etag;

          // Honoured so the tag is worth sending: a client that revalidates
          // anyway — a reload, or a cache that has evicted the body — gets an
          // empty answer instead of the image a second time.
          if (matchesEtag(request.headers.get('if-none-match'), etag)) {
            set.status = 304;
            return undefined;
          }

          set.headers['Content-Type'] = image.mimeType;
          return image.body;
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      }
    )

    .delete(
      '/:subjectKey',
      {
        params: subjectKeyParams,
        response: {
          204: t.Void(),
          ...errorResponses,
        },
      },
      async ({ params, set, user }): Promise<undefined | ApiErrorResponse> => {
        try {
          await resetToolIdentity(getDb(), user?.id ?? '', params.subjectKey);
          set.status = 204;
          return undefined;
        } catch (error) {
          return handleToolIdentityError(error, set);
        }
      }
    )
);
