import { ApiErrorResponseSchema, ERROR_CODES } from '@mangostudio/shared/errors';
import { ChatTodosResponseSchema } from '@mangostudio/shared/todos';
import { type Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { assertChatOwnership, ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { getChatTodosState } from '../infrastructure/todo-repository';

export const todoRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app.use(requireAuth).get(
      '/:id/todos',
      {
        params: t.Object({ id: t.String() }),
        response: { 200: ChatTodosResponseSchema, 404: ApiErrorResponseSchema },
      },
      /** Current todo state for a chat owned by the authenticated user. */
      async ({ params, user }) => {
        const userId = user?.id ?? '';
        try {
          await assertChatOwnership(params.id, userId, getDb());
        } catch (err) {
          if (err instanceof ChatNotFoundError) {
            return status(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
          }
          throw err;
        }
        return getChatTodosState(getDb(), userId, params.id);
      }
    )
  );
