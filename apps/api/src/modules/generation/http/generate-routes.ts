import { ERROR_CODES } from '@mangostudio/shared/errors';
import { GenerateImageBodySchema } from '@mangostudio/shared/generation';
import type { Elysia } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import { requireAuth } from '../../../plugins/auth-middleware';
import { ChatNotFoundError } from '../../chats/domain/chat-ownership';
import { generateImage, ImageProviderNotSupportedError } from '../application/generate-image';
import { NoModelAvailableError } from '../application/resolve-model';
import { modelUnavailableResponse } from './model-unavailable-response';

export const generateRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/generate
       * Image generation: persists user message, calls provider, persists AI image, returns both.
       */
      .post('/generate', { body: GenerateImageBodySchema }, async ({ body, user }) => {
        try {
          return await generateImage(
            {
              chatId: body.chatId,
              userId: user?.id ?? '',
              prompt: body.prompt,
              model: body.model,
              systemPrompt: body.systemPrompt,
              promptSettings: body.promptSettings,
              referenceImageUrl: body.referenceImageUrl,
              imageQuality: body.imageQuality,
            },
            getDb()
          );
        } catch (err) {
          if (err instanceof ChatNotFoundError) {
            return apiErrorStatus(404, { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND });
          }
          if (err instanceof NoModelAvailableError) {
            const refusal = modelUnavailableResponse(err);
            return apiErrorStatus(refusal.status, refusal.body);
          }
          if (err instanceof ImageProviderNotSupportedError) {
            return apiErrorStatus(422, { error: err.message, code: ERROR_CODES.PROVIDER_ERROR });
          }
          console.error('[generate] Error:', err);
          return apiErrorStatus(500, {
            error: 'Image generation failed. Please try again.',
            code: ERROR_CODES.PROVIDER_ERROR,
          });
        }
      })
  );
