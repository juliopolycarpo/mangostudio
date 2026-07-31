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

async function resolveRuntimeSelection(
  userId: string,
  chatId: string | undefined
): Promise<RuntimeSelection | null> {
  if (!chatId) return null;
  const chat = await getOwnedChat(chatId, userId, getDb());
  return chat ? { userId, environmentId: chat.environmentId } : null;
}

export const workspaceRoutes = new Elysia().use(requireAuth).group('/workspace/fs', (app) =>
  app
    .get(
      '/',
      async ({ query, set, user }): Promise<ListDirectoryResponse | ApiErrorResponse> => {
        try {
          const selection = await resolveRuntimeSelection(user?.id ?? '', query.chatId);
          if (query.chatId && !selection) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          return await listDirectory(query.path, selection ?? undefined);
        } catch (error) {
          return handleDirectoryBrowserError(error, set);
        }
      },
      {
        query: ListDirectoryQuerySchema,
      }
    )
    .post(
      '/validate',
      async ({ body, set, user }): Promise<ValidatePathResponse | ApiErrorResponse> => {
        try {
          const selection = await resolveRuntimeSelection(user?.id ?? '', body.chatId);
          if (body.chatId && !selection) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          return await validateWorkdir(body.path, selection ?? undefined);
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
