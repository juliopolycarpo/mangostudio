import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
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
        async ({ params, user, set }) => {
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
        },
        { params: t.Object({ id: t.String() }) }
      )
      .post(
        '/:id/checkpoints/:messageId/revert',
        async ({ params, user, set }): Promise<ApiErrorResponse | { revertedFiles: number }> => {
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
            throw error;
          }
        },
        { params: t.Object({ id: t.String(), messageId: t.String() }) }
      )
  );
