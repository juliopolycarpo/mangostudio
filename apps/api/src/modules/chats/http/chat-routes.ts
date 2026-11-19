import {
  ChatListPageSchema,
  ChatSchema,
  CompactChatBodySchema,
  ContextCompactionResponseSchema,
  CreateChatBodySchema,
  GenerateChatTitleBodySchema,
  GenerateChatTitleResponseSchema,
  ListChatMessagesQuerySchema,
  ListChatsQuerySchema,
  MessagesPageSchema,
  SummarizeToNewChatBodySchema,
  UpdateChatBodySchema,
} from '@mangostudio/shared/chat';
import {
  type ApiErrorResponse,
  ApiErrorResponseSchema,
  ERROR_CODES,
} from '@mangostudio/shared/errors';
import { WorkspacePathError } from '@mangostudio/shared/runtime-contract';
import { type Elysia, status, t } from 'elysia';

import { getDb } from '../../../db/database';
import { createJsonResponseEncoder } from '../../../lib/compiled-json-response';
import { generationDeadlineResponse } from '../../../lib/generation-deadline-response';
import { requireAuth } from '../../../plugins/auth-middleware';
import { NoModelAvailableError } from '../../generation/application/resolve-model';
import { modelUnavailableResponse } from '../../generation/http/model-unavailable-response';
import { InvalidTranscriptCursorError } from '../../messages/domain/transcript-cursor';
import {
  OperationConflictError,
  OperationExpiredError,
} from '../../operations/application/product-operation';
import { WorkdirValidationError } from '../../workspaces/application/workdir-validation';
import {
  compactChatUseCase,
  EmptyChatCompactionError,
  ExternalChatCompactionUnsupportedError,
  summarizeToNewChatUseCase,
} from '../application/context-compaction';
import { createChatUseCase } from '../application/create-chat';
import { deleteChatUseCase } from '../application/delete-chat';
import {
  EmptyChatTitlePromptError,
  generateChatTitleUseCase,
} from '../application/generate-chat-title';
import { getChatMessagesUseCase } from '../application/get-chat-messages';
import { type ListChatsInput, listChatsUseCase } from '../application/list-chats';
import { EnvironmentSelectionError, updateChatUseCase } from '../application/update-chat';
import {
  type ChatListCursor,
  decodeChatListCursor,
  InvalidChatListCursorError,
} from '../domain/chat-list-cursor';
import { ChatNotFoundError } from '../domain/chat-ownership';
import { RunnerKindImmutableError } from '../infrastructure/chat-repository';

/**
 * The chat list is the largest response on the first screen, so a page is
 * encoded through a compiled validator rather than the framework's per-item
 * interpreted check. The route still declares `ChatListPageSchema` for OpenAPI
 * and client types.
 */
const encodeChatList = createJsonResponseEncoder(ChatListPageSchema);

async function encodeChatListPage(input: ListChatsInput): Promise<Response> {
  return encodeChatList(await listChatsUseCase(input, getDb()));
}

function apiError(error: string, code: string): ApiErrorResponse {
  return { error, code };
}

/** The `{ success: true }` acknowledgement the chat update route answers with. */
const SuccessResponseSchema = t.Object({ success: t.Literal(true) });

/**
 * Maps the failures `compact` and `summarize-to-new-chat` share to a typed
 * status answer, so each body lands in Eden's `error` channel. Rethrows any
 * other error to the framework's error handler.
 */
function compactionFailure(err: unknown) {
  if (err instanceof ChatNotFoundError) {
    return status(404, apiError('Chat not found', ERROR_CODES.NOT_FOUND));
  }
  if (err instanceof EmptyChatCompactionError) {
    return status(400, apiError(err.message, ERROR_CODES.VALIDATION));
  }
  if (err instanceof ExternalChatCompactionUnsupportedError) {
    return status(409, apiError(err.message, ERROR_CODES.UNSUPPORTED));
  }
  if (err instanceof NoModelAvailableError) {
    const refusal = modelUnavailableResponse(err);
    return status(refusal.status, refusal.body);
  }
  throw err;
}

export const chatRoutes = (app: Elysia) =>
  app.group('/chats', (app) =>
    app
      .use(requireAuth)
      /**
       * One page of the authenticated user's chats, most recently updated first.
       * `nextCursor` of a page is the `cursor` of the next; it is `null` on the last.
       */
      .get(
        '/',
        {
          query: ListChatsQuerySchema,
          response: { 200: ChatListPageSchema, 400: ApiErrorResponseSchema },
        },
        // Not `async`: the answer is either a `Response` (the compiled encoder's)
        // or a typed 400, and Elysia accepts those two only as separate return
        // types, not as the two halves of one promise. So the cursor is read
        // synchronously, before the page is.
        ({ query, user }) => {
          let after: ChatListCursor | undefined;
          try {
            after = query.cursor === undefined ? undefined : decodeChatListCursor(query.cursor);
          } catch (err) {
            if (err instanceof InvalidChatListCursorError) {
              return status(400, apiError(err.message, ERROR_CODES.VALIDATION));
            }
            throw err;
          }
          return encodeChatListPage({ userId: user?.id ?? '', after, limit: query.limit });
        }
      )

      /** Create a new chat for the authenticated user. */
      .post(
        '/',
        {
          body: CreateChatBodySchema,
          response: {
            200: ChatSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            410: ApiErrorResponseSchema,
          },
        },
        async ({ body, user }) => {
          try {
            return await createChatUseCase(
              {
                title: body.title,
                model: body.model,
                userId: user?.id ?? '',
                operationId: body.operationId,
              },
              getDb()
            );
          } catch (error) {
            if (error instanceof OperationExpiredError) {
              return status(410, apiError(error.message, ERROR_CODES.OPERATION_EXPIRED));
            }
            if (error instanceof OperationConflictError) {
              return status(409, apiError(error.message, ERROR_CODES.CONFLICT));
            }
            if (error instanceof ChatNotFoundError) {
              return status(404, apiError('Chat not found', ERROR_CODES.NOT_FOUND));
            }
            throw error;
          }
        }
      )

      .post(
        '/title-suggestion',
        {
          body: GenerateChatTitleBodySchema,
          response: {
            200: GenerateChatTitleResponseSchema,
            400: ApiErrorResponseSchema,
            500: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
            504: ApiErrorResponseSchema,
          },
        },
        async ({ body, user }) => {
          try {
            return await generateChatTitleUseCase({
              userId: user?.id ?? '',
              prompt: body.prompt,
              model: body.model,
            });
          } catch (err) {
            if (err instanceof EmptyChatTitlePromptError) {
              return status(400, apiError(err.message, ERROR_CODES.VALIDATION));
            }
            if (err instanceof NoModelAvailableError) {
              const refusal = modelUnavailableResponse(err);
              return status(refusal.status, refusal.body);
            }
            const timedOut = generationDeadlineResponse(err);
            if (timedOut) return timedOut;
            return status(
              500,
              apiError('Chat title generation failed.', ERROR_CODES.PROVIDER_ERROR)
            );
          }
        }
      )

      /** Update a chat owned by the authenticated user. */
      .put(
        '/:id',
        {
          params: t.Object({ id: t.String() }),
          body: UpdateChatBodySchema,
          response: {
            200: SuccessResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            422: ApiErrorResponseSchema,
          },
        },
        async ({ params, body, user }) => {
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
                  runner: body.runner,
                  runnerPermissions: body.runnerPermissions,
                  runnerModelSelection: body.runnerModelSelection,
                  workdir: body.workdir,
                  environmentId: body.environmentId,
                  restrictToolsToWorkdir: body.restrictToolsToWorkdir,
                },
              },
              getDb()
            );
            return { success: true as const };
          } catch (error) {
            if (
              error instanceof WorkdirValidationError ||
              error instanceof EnvironmentSelectionError ||
              error instanceof RunnerKindImmutableError
            ) {
              return status(422, apiError(error.message, ERROR_CODES.VALIDATION));
            }
            if (error instanceof ChatNotFoundError) {
              return status(404, apiError('Chat not found', ERROR_CODES.NOT_FOUND));
            }
            if (error instanceof WorkspacePathError) {
              return status(400, apiError(error.message, ERROR_CODES.VALIDATION));
            }
            throw error;
          }
        }
      )

      .post(
        '/:id/compact',
        {
          params: t.Object({ id: t.String() }),
          body: CompactChatBodySchema,
          response: {
            200: ContextCompactionResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
            504: ApiErrorResponseSchema,
          },
        },
        async ({ params, body, request, user }) => {
          try {
            return await compactChatUseCase(
              {
                chatId: params.id,
                userId: user?.id ?? '',
                model: body.model,
                signal: request.signal,
              },
              getDb()
            );
          } catch (err) {
            return compactionFailure(err);
          }
        }
      )

      .post(
        '/:id/summarize-to-new-chat',
        {
          params: t.Object({ id: t.String() }),
          body: SummarizeToNewChatBodySchema,
          response: {
            200: ContextCompactionResponseSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
            409: ApiErrorResponseSchema,
            503: ApiErrorResponseSchema,
            504: ApiErrorResponseSchema,
          },
        },
        async ({ params, body, request, user }) => {
          try {
            return await summarizeToNewChatUseCase(
              {
                chatId: params.id,
                userId: user?.id ?? '',
                model: body.model,
                signal: request.signal,
              },
              getDb()
            );
          } catch (err) {
            return compactionFailure(err);
          }
        }
      )

      /** Delete a chat and its messages (cascades) if owned by the user. */
      .delete('/:id', { params: t.Object({ id: t.String() }) }, async ({ params, user }) => {
        await deleteChatUseCase({ chatId: params.id, userId: user?.id ?? '' }, getDb());
        return { success: true };
      })

      /** Get messages for a specific chat with ownership verification and cursor pagination. */
      .get(
        '/:id/messages',
        {
          params: t.Object({ id: t.String() }),
          query: ListChatMessagesQuerySchema,
          response: {
            200: MessagesPageSchema,
            400: ApiErrorResponseSchema,
            404: ApiErrorResponseSchema,
          },
        },
        async ({ params, query, user }) => {
          try {
            return await getChatMessagesUseCase(
              {
                chatId: params.id,
                userId: user?.id ?? '',
                cursor: query.cursor,
                limit: query.limit,
                order: query.order,
              },
              getDb()
            );
          } catch (err) {
            if (err instanceof InvalidTranscriptCursorError) {
              return status(400, apiError(err.message, ERROR_CODES.VALIDATION));
            }
            if (err instanceof ChatNotFoundError) {
              return status(404, apiError('Chat not found', ERROR_CODES.NOT_FOUND));
            }
            throw err;
          }
        }
      )
  );
