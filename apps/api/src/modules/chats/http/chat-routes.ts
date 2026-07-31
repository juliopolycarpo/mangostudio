import {
  ChatListSchema,
  ChatSchema,
  CompactChatBodySchema,
  CreateChatBodySchema,
  GenerateChatTitleBodySchema,
  SummarizeToNewChatBodySchema,
  UpdateChatBodySchema,
} from '@mangostudio/shared/chat';
import { type ApiErrorResponse, ERROR_CODES } from '@mangostudio/shared/errors';
import { type Elysia, t } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { parseQueryInt } from '../../../utils/query';
import { NoModelAvailableError } from '../../generation/application/resolve-model';
import { WorkdirValidationError } from '../../workspaces/application/workdir-validation';
import { WorkspacePathError } from '../../workspaces/application/workspace-path';
import {
  compactChatUseCase,
  EmptyChatCompactionError,
  summarizeToNewChatUseCase,
} from '../application/context-compaction';
import { createChatUseCase } from '../application/create-chat';
import { deleteChatUseCase } from '../application/delete-chat';
import {
  EmptyChatTitlePromptError,
  generateChatTitleUseCase,
} from '../application/generate-chat-title';
import { getChatMessagesUseCase } from '../application/get-chat-messages';
import { listChatsUseCase } from '../application/list-chats';
import { EnvironmentSelectionError, updateChatUseCase } from '../application/update-chat';
import { ChatNotFoundError } from '../domain/chat-ownership';

function apiError(error: string, code: string): ApiErrorResponse {
  return { error, code };
}

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /** List all chats for the authenticated user ordered by most recently updated. */
      .get(
        '/',
        ({ user }) => {
          return listChatsUseCase(user?.id ?? '', getDb());
        },
        { response: { 200: ChatListSchema } }
      )

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        // biome-ignore lint/suspicious/useAwait: Migrated from ESLint
        async ({ body, user }) => {
          return createChatUseCase(
            { title: body.title, model: body.model, userId: user?.id ?? '' },
            getDb()
          );
        },
        { body: CreateChatBodySchema, response: { 200: ChatSchema } }
      )

      .post(
        '/title-suggestion',
        async ({ body, user, set }) => {
          try {
            return await generateChatTitleUseCase({
              userId: user?.id ?? '',
              prompt: body.prompt,
              model: body.model,
            });
          } catch (err) {
            if (err instanceof EmptyChatTitlePromptError) {
              set.status = 400;
              return apiError(err.message, ERROR_CODES.VALIDATION);
            }
            if (err instanceof NoModelAvailableError) {
              set.status = 503;
              return apiError(err.message, ERROR_CODES.PROVIDER_ERROR);
            }
            set.status = 500;
            return apiError('Chat title generation failed.', ERROR_CODES.PROVIDER_ERROR);
          }
        },
        { body: GenerateChatTitleBodySchema }
      )

      /** Update a chat owned by the authenticated user. */
      .put(
        '/:id',
        async ({ params, body, user, set }) => {
          try {
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
                  selectedAgentId: body.selectedAgentId,
                  workdir: body.workdir,
                  environmentId: body.environmentId,
                  restrictToolsToWorkdir: body.restrictToolsToWorkdir,
                },
              },
              getDb()
            );
            return { success: true };
          } catch (error) {
            if (
              error instanceof WorkdirValidationError ||
              error instanceof EnvironmentSelectionError
            ) {
              set.status = 422;
              return apiError(error.message, ERROR_CODES.VALIDATION);
            }
            if (error instanceof ChatNotFoundError) {
              set.status = 404;
              return apiError('Chat not found', ERROR_CODES.NOT_FOUND);
            }
            if (error instanceof WorkspacePathError) {
              set.status = 400;
              return apiError(error.message, ERROR_CODES.VALIDATION);
            }
            throw error;
          }
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
