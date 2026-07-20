import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { ValidatePathBodySchema } from '@mangostudio/shared/workspaces';
import { Elysia, t } from 'elysia';
import { requireAuth } from '../../../plugins/auth-middleware';
import { DirectoryBrowserError, listDirectory } from '../application/directory-browser';
import { validateWorkdir } from '../application/workdir-validation';
import { WorkspacePathError } from '../application/workspace-path';

function handleDirectoryBrowserError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof DirectoryBrowserError) {
    if (error.code === 'VALIDATION') {
      set.status = 400;
      return { error: error.message, code: 'VALIDATION' };
    }

    switch (error.reason) {
      case 'not-found':
        set.status = 404;
        return { error: error.message, code: 'NOT_FOUND' };
      case 'not-a-directory':
        set.status = 422;
        return { error: error.message, code: 'NOT_A_DIRECTORY' };
      case 'permission-denied':
        set.status = 403;
        return { error: error.message, code: 'PERMISSION_DENIED' };
      default:
        break;
    }
  }

  console.error('[workspace] Unexpected directory browsing error:', error);
  set.status = 500;
  return { error: 'Unexpected directory browsing error.', code: 'INTERNAL' };
}

export const workspaceRoutes = new Elysia().use(requireAuth).group('/workspace/fs', (app) =>
  app
    .get(
      '/',
      async ({ query, set }): Promise<ListDirectoryResponse | ApiErrorResponse> => {
        try {
          return await listDirectory(query.path);
        } catch (error) {
          return handleDirectoryBrowserError(error, set);
        }
      },
      {
        query: t.Object({ path: t.Optional(t.String()) }),
      }
    )
    .post(
      '/validate',
      async ({ body, set }): Promise<ValidatePathResponse | ApiErrorResponse> => {
        try {
          return await validateWorkdir(body.path);
        } catch (error) {
          if (error instanceof WorkspacePathError) {
            set.status = 400;
            return { error: error.message, code: ERROR_CODES.VALIDATION };
          }
          throw error;
        }
      },
      { body: ValidatePathBodySchema }
    )
);
