import { type Elysia } from 'elysia';
import { GenerateImageBodySchema } from '@mangostudio/shared/generation';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import '../../../services/providers'; // ensure all providers are registered
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { generateImage, ImageProviderNotSupportedError } from '../application/generate-image';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { NoModelAvailableError } from '../application/resolve-model';

export const generateRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/generate
       * Image generation: persists user message, calls provider, persists AI image, returns both.
       */
      .post(
        '/generate',
        async ({ body, set, user }) => {
          try {
            return await generateImage(
              {
                chatId: body.chatId,
                userId: user?.id ?? '',
                prompt: body.prompt,
                model: body.model,
                systemPrompt: body.systemPrompt,
                referenceImageUrl: body.referenceImageUrl,
                imageQuality: body.imageQuality,
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
            if (err instanceof ImageProviderNotSupportedError) {
              set.status = 422;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
            }
            console.error('[generate] Error:', err);
            set.status = 500;
            return {
              error: 'Image generation failed. Please try again.',
              code: ERROR_CODES.PROVIDER_ERROR,
            };
          }
        },
        { body: GenerateImageBodySchema }
      )
  );
