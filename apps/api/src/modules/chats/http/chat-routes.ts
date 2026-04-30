import { type Elysia, t } from 'elysia';
import {
  CompactChatBodySchema,
  CreateChatBodySchema,
  SummarizeToNewChatBodySchema,
  UpdateChatBodySchema,
} from '@mangostudio/shared/chat';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { parseQueryInt } from '../../../utils/query';
import {
  compactChatUseCase,
  EmptyChatCompactionError,
  summarizeToNewChatUseCase,
} from '../application/context-compaction';
import { createChatUseCase } from '../application/create-chat';
import { updateChatUseCase } from '../application/update-chat';
import { deleteChatUseCase } from '../application/delete-chat';
import { listChatsUseCase } from '../application/list-chats';
import { getChatMessagesUseCase } from '../application/get-chat-messages';
import { ChatNotFoundError } from '../domain/chat-ownership';
import { NoModelAvailableError } from '../../generation/application/resolve-model';

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /** List all chats for the authenticated user ordered by most recently updated. */
      .get('/', async ({ user }) => {
        return listChatsUseCase(user?.id ?? '', getDb());
      })

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        async ({ body, user }) => {
          return createChatUseCase(
            { title: body.title, model: body.model, userId: user?.id ?? '' },
            getDb()
          );
        },
        { body: CreateChatBodySchema }
      )

      /** Update a chat owned by the authenticated user. */
      .put(
        '/:id',
        async ({ params, body, user }) => {
          await updateChatUseCase(
            {
              chatId: params.id,
              userId: user?.id ?? '',
              updates: {
                title: body.title,
                model: body.model,
                textModel: body.textModel,
                imageModel: body.imageModel,
                lastUsedMode: body.lastUsedMode,
              },
            },
            getDb()
          );
          return { success: true };
        },
        {
          params: t.Object({ id: t.String() }),
          body: UpdateChatBodySchema,
        }
      )

      .post(
        '/:id/compact',
        async ({ params, body, user, set }) => {
          try {
            return await compactChatUseCase(
              { chatId: params.id, userId: user?.id ?? '', model: body.model },
              getDb()
            );
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              set.status = 404;
              return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
            }
            if (err instanceof EmptyChatCompactionError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            if (err instanceof NoModelAvailableError) {
              set.status = 503;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
            }
            throw err;
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: CompactChatBodySchema,
        }
      )

      .post(
        '/:id/summarize-to-new-chat',
        async ({ params, body, user, set }) => {
          try {
            return await summarizeToNewChatUseCase(
              { chatId: params.id, userId: user?.id ?? '', model: body.model },
              getDb()
            );
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              set.status = 404;
              return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
            }
            if (err instanceof EmptyChatCompactionError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            if (err instanceof NoModelAvailableError) {
              set.status = 503;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
            }
            throw err;
          }
        },
        {
          params: t.Object({ id: t.String() }),
          body: SummarizeToNewChatBodySchema,
        }
      )

      /** Delete a chat and its messages (cascades) if owned by the user. */
      .delete(
        '/:id',
        async ({ params, user }) => {
          await deleteChatUseCase({ chatId: params.id, userId: user?.id ?? '' }, getDb());
          return { success: true };
        },
        { params: t.Object({ id: t.String() }) }
      )

      /** Get messages for a specific chat with ownership verification and cursor pagination. */
      .get(
        '/:id/messages',
        async ({ params, query, user, set }) => {
          try {
            return await getChatMessagesUseCase(
              {
                chatId: params.id,
                userId: user?.id ?? '',
                cursor: query.cursor ? parseQueryInt(query.cursor, 0) : undefined,
                limit: query.limit ? parseQueryInt(query.limit, 50) : undefined,
              },
              getDb()
            );
          } catch (err) {
            if (err instanceof ChatNotFoundError) {
              set.status = 404;
              return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
            }
            throw err;
          }
        },
        {
          params: t.Object({ id: t.String() }),
          query: t.Object({
            limit: t.Optional(t.String()),
            cursor: t.Optional(t.String()),
          }),
        }
      )
  );
