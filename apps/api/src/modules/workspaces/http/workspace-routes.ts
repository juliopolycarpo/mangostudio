import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import type { ListDirectoryResponse, ValidatePathResponse } from '@mangostudio/shared/workspaces';
import { ListDirectoryQuerySchema, ValidatePathBodySchema } from '@mangostudio/shared/workspaces';
import { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import { environmentRepository } from '../../environments/infrastructure/environment-repository';
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
 * What a request's scope resolved to.
 *
 * `missing` is its own member rather than a null: a chat and an environment are
 * both things a caller can name and get wrong, and the 404 has to say which one
 * it could not find.
 */
type ScopeResolution =
  | { readonly kind: 'runtime'; readonly selection: RuntimeSelection }
  | { readonly kind: 'hub' }
  | { readonly kind: 'missing'; readonly message: string };

/**
 * Which machine to read, from whichever of the two ways the caller named it.
 *
 * Both ways are checked against what this user owns before anything is opened
 * on them. An id that names nothing must answer 404 like any other missing
 * resource — handed to the connection manager unchecked it becomes an
 * unavailable-runtime failure, which surfaces as a 500 about the hub rather
 * than as a refusal about the id the caller sent.
 *
 * Naming neither keeps the historical answer: the hub's own filesystem.
 *
 * @example
 * const scope = await resolveRuntimeSelection(user.id, { environmentId: 'local' });
 */
async function resolveRuntimeSelection(
  userId: string,
  scope: { readonly chatId?: string; readonly environmentId?: string }
): Promise<ScopeResolution> {
  if (scope.chatId && scope.environmentId) {
    throw new ConflictingScopeError(
      `Name either a chat or an environment, not both. Received chatId "${scope.chatId}" and environmentId "${scope.environmentId}".`
    );
  }
  if (scope.environmentId) return await environmentScope(userId, scope.environmentId);
  if (!scope.chatId) return { kind: 'hub' };
  const chat = await getOwnedChat(scope.chatId, userId, getDb());
  if (!chat) return { kind: 'missing', message: 'Chat not found' };
  return { kind: 'runtime', selection: { userId, environmentId: chat.environmentId } };
}

/** The hub's own machine is virtual, so it is never a repository row. */
async function environmentScope(userId: string, environmentId: string): Promise<ScopeResolution> {
  if (environmentId === LOCAL_ENVIRONMENT_ID) {
    return { kind: 'runtime', selection: { userId, environmentId } };
  }
  const record = await environmentRepository.find(userId, environmentId);
  if (!record) return { kind: 'missing', message: 'Environment not found' };
  return { kind: 'runtime', selection: { userId, environmentId } };
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
          const scope = await resolveRuntimeSelection(user?.id ?? '', query);
          if (scope.kind === 'missing') {
            set.status = 404;
            return { error: scope.message, code: ERROR_CODES.NOT_FOUND };
          }
          return await listDirectory(
            query.path,
            scope.kind === 'runtime' ? scope.selection : undefined
          );
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
          const scope = await resolveRuntimeSelection(user?.id ?? '', body);
          if (scope.kind === 'missing') {
            set.status = 404;
            return { error: scope.message, code: ERROR_CODES.NOT_FOUND };
          }
          return await validateWorkdir(
            body.path,
            scope.kind === 'runtime' ? scope.selection : undefined
          );
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
