import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { ListDirectoryQuerySchema, ValidatePathBodySchema } from '@mangostudio/shared/workspaces';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import { DirectoryBrowserError, listDirectory } from '../application/directory-browser';
import { type RuntimeSelection, validateWorkdir } from '../application/workdir-validation';
import { WorkspacePathError } from '../application/workspace-path';

function handleDirectoryBrowserError(
  error: unknown,
  set: { status?: number | string }
): ApiErrorResponse {
  if (error instanceof DirectoryBrowserError) {
    if (error.code === 'VALIDATION') {
      set.status = 400;
      return { error: error.message, code: ERROR_CODES.VALIDATION };
    }

    switch (error.reason) {
      case 'not-found':
        set.status = 404;
        return { error: error.message, code: ERROR_CODES.NOT_FOUND };
      case 'not-a-directory':
        set.status = 422;
        return { error: error.message, code: ERROR_CODES.NOT_A_DIRECTORY };
      case 'permission-denied':
        set.status = 403;
        return { error: error.message, code: ERROR_CODES.PERMISSION_DENIED };
      default:
        break;
    }
  }

  console.error('[workspace] Unexpected directory browsing error:', error);
  set.status = 500;
  return { error: 'Unexpected directory browsing error.', code: ERROR_CODES.INTERNAL };
}

/** Raised when a request names a chat and an environment at once. */
class ConflictingScopeError extends Error {}

/**
 * Which machine to read, from whichever of the two ways the caller named it.
 *
 * `null` means "the caller named a chat that does not exist" — the route turns
 * that into a 404. Naming neither keeps the historical answer: the hub's own
 * filesystem.
 */
async function resolveRuntimeSelection(
  userId: string,
  scope: { readonly chatId?: string; readonly environmentId?: string }
): Promise<RuntimeSelection | null | undefined> {
  if (scope.chatId && scope.environmentId) {
    throw new ConflictingScopeError('Name either a chat or an environment, not both.');
  }
  if (scope.environmentId) return { userId, environmentId: scope.environmentId };
  if (!scope.chatId) return undefined;
  const chat = await getOwnedChat(scope.chatId, userId, getDb());
  return chat ? { userId, environmentId: chat.environmentId } : null;
}

export const workspaceRoutes = new Elysia().use(requireAuth).group('/workspace/fs', (app) =>
  app
    .get(
      '/',
      {
        query: ListDirectoryQuerySchema,
      },
      async ({ query, set, user }): Promise<ListDirectoryResponse | ApiErrorResponse> => {
        try {
          const selection = await resolveRuntimeSelection(user?.id ?? '', query);
          if (selection === null) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          return await listDirectory(query.path, selection);
        } catch (error) {
          if (error instanceof ConflictingScopeError) {
            set.status = 400;
            return { error: error.message, code: ERROR_CODES.VALIDATION };
          }
          return handleDirectoryBrowserError(error, set);
        }
      }
    )
    .post(
      '/validate',
      { body: ValidatePathBodySchema },
      async ({ body, set, user }): Promise<ValidatePathResponse | ApiErrorResponse> => {
        try {
          const selection = await resolveRuntimeSelection(user?.id ?? '', body);
          if (selection === null) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          return await validateWorkdir(body.path, selection);
        } catch (error) {
          if (error instanceof WorkspacePathError || error instanceof ConflictingScopeError) {
            set.status = 400;
            return { error: error.message, code: ERROR_CODES.VALIDATION };
          }
          throw error;
        }
      }
    )
);
