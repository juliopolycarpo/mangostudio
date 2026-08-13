import { PathAccessError } from '@mangostudio/runtime';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import {
  type ChatFileCheckpointsResponse,
  ChatFileCheckpointsResponseSchema,
  type RevertChatFileCheckpointsResponse,
  RevertChatFileCheckpointsResponseSchema,
} from '@mangostudio/shared/file-checkpoints';
import { type Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { assertChatOwnership, ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { listChatFileCheckpointSummaries } from '../application/list-chat-checkpoints';
import {
  FileCheckpointConflictError,
  revertMessageFileCheckpoints,
} from '../application/revert-message-checkpoints';

export const fileCheckpointRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      .get(
        '/:id/checkpoints',
        {
          params: t.Object({ id: t.String() }),
          response: {
            200: ChatFileCheckpointsResponseSchema,
            404: ApiErrorResponseSchema,
          },
        },
        async ({ params, user, set }): Promise<ApiErrorResponse | ChatFileCheckpointsResponse> => {
          const userId = user?.id ?? '';
          try {
            await assertChatOwnership(params.id, userId, getDb());
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              set.status = 404;
              return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
            }
            throw err;
          }
          const checkpoints = await listChatFileCheckpointSummaries(getDb(), params.id);
          return { checkpoints };
        }
      )
      .post(
        '/:id/checkpoints/:messageId/revert',
        {
          params: t.Object({ id: t.String(), messageId: t.String() }),
          response: {
            200: RevertChatFileCheckpointsResponseSchema,
            403: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
          },
        },
        async ({
          params,
          user,
          set,
        }): Promise<ApiErrorResponse | RevertChatFileCheckpointsResponse> => {
          const userId = user?.id ?? '';
          try {
            await assertChatOwnership(params.id, userId, getDb());
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              set.status = 404;
              return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
            }
            throw err;
          }
          try {
            return await revertMessageFileCheckpoints(getDb(), params.id, params.messageId);
          } catch (error) {
            if (error instanceof FileCheckpointConflictError) {
              set.status = 409;
              return { error: error.message, code: ERROR_CODES.CONFLICT };
            }
            if (error instanceof PathAccessError) {
              set.status = 403;
              return { error: error.message, code: ERROR_CODES.PERMISSION_DENIED };
            }
            throw error;
          }
        }
      )
  );
