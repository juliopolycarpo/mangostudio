import { type Elysia } from 'elysia';
import { GenerateTextBodySchema } from '@mangostudio/shared/generation';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import '../../../services/providers'; // ensure all providers are registered
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { sendTextMessage } from '../application/send-text-message';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { NoModelAvailableError } from '../application/resolve-model';

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
              set.status = 503;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
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
