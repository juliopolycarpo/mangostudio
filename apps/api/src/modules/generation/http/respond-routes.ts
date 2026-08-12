import { ERROR_CODES } from '@mangostudio/shared/errors';
import { GenerateTextBodySchema } from '@mangostudio/shared/generation';
import type { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatAttachmentNotFoundError } from '../../attachments/infrastructure/attachment-repository';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
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
      .post(
        '/respond',
        async ({ body, set, user }) => {
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
        },
        { body: GenerateTextBodySchema }
      )
  );
