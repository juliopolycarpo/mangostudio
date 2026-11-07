import { ERROR_CODES } from '@mangostudio/shared/errors';
import { GenerateTextBodySchema } from '@mangostudio/shared/generation';
import type { Elysia } from 'elysia';

import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatAttachmentNotFoundError } from '../../attachments/infrastructure/attachment-repository';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import {
  claimOperation,
  finishOperation,
  OperationConflictError,
  OperationExpiredError,
  operationReceipt,
  releaseOperation,
  settleOperation,
} from '../../operations/application/product-operation';
import { NoModelAvailableError } from '../application/resolve-model';
import { sendTextMessage, UnsupportedChatRunnerError } from '../application/send-text-message';
import { EmptyTextTurnError } from '../application/text-turn-content';
import { modelUnavailableResponse } from './model-unavailable-response';

export const respondRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/respond
       * Text-chat: persists user message, calls provider, persists AI reply, returns both.
       */
      .post('/respond', { body: GenerateTextBodySchema }, async ({ body, set, user }) => {
        const db = getDb();
        const userId = user?.id ?? '';
        const operationId = body.operationId;
        if (operationId) {
          const chat = await getOwnedChat(body.chatId, userId, db);
          if (!chat) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          try {
            const { row, claimed } = await claimOperation(
              db,
              userId,
              operationId,
              'submit-turn',
              {
                transport: 'respond',
                request: { ...body, operationId: undefined },
                runner: chat.runner,
                environmentId: chat.environmentId,
                workdir: chat.workdir,
                restrictToolsToWorkdir: chat.restrictToolsToWorkdir,
              },
              body.chatId
            );
            if (!claimed) return operationReceipt(row);
            try {
              await finishOperation(db, userId, operationId, 'running');
            } catch (error) {
              // Dispatch has not started, so the caller can safely retry the key.
              try {
                await releaseOperation(db, userId, operationId);
              } catch (releaseError) {
                console.error('[respond] Could not release undispatched receipt', releaseError);
              }
              throw error;
            }
            void (async () => {
              let result: Awaited<ReturnType<typeof sendTextMessage>>;
              try {
                result = await sendTextMessage({ ...body, userId, admittedChat: chat }, db);
              } catch {
                // No automatic replay; the request was admitted even if execution failed.
                await settleOperation(db, userId, operationId, 'failed');
                return;
              }
              await settleOperation(db, userId, operationId, 'completed', result.aiMessage.id);
            })();
            return operationReceipt({ ...row, state: 'running' });
          } catch (error) {
            if (error instanceof OperationConflictError || error instanceof OperationExpiredError) {
              const expired = error instanceof OperationExpiredError;
              set.status = expired ? 410 : 409;
              return {
                error: error.message,
                code: expired ? ERROR_CODES.OPERATION_EXPIRED : ERROR_CODES.CONFLICT,
              };
            }
            throw error;
          }
        }
        try {
          return await sendTextMessage(
            {
              chatId: body.chatId,
              userId: user?.id ?? '',
              prompt: body.prompt,
              attachmentIds: body.attachmentIds,
              model: body.model,
              systemPrompt: body.systemPrompt,
            },
            getDb()
          );
        } catch (err) {
          if (err instanceof ChatNotFoundError) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }
          if (err instanceof NoModelAvailableError) {
            const refusal = modelUnavailableResponse(err);
            set.status = refusal.status;
            return refusal.body;
          }
          if (err instanceof ChatAttachmentNotFoundError || err instanceof EmptyTextTurnError) {
            set.status = 400;
            return { error: err.message, code: ERROR_CODES.VALIDATION };
          }
          if (err instanceof UnsupportedChatRunnerError) {
            set.status = 409;
            return { error: err.message, code: ERROR_CODES.UNSUPPORTED };
          }
          console.error('[respond] Error:', err);
          set.status = 500;
          return {
            error: 'Text generation failed. Please try again.',
            code: ERROR_CODES.PROVIDER_ERROR,
          };
        }
      })
  );
