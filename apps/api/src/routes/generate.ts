/**
 * Generate route: unified image generation endpoint.
 * Resolves the AI provider dynamically from the requested model.
 */

import { type Elysia } from 'elysia';
import { GenerateImageBodySchema } from '@mangostudio/shared/generation';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import '../services/providers'; // ensure all providers are registered
import { getProviderForModel } from '../services/providers/registry';
import { getUnifiedModelCatalog } from '../services/providers/catalog';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { generateId } from '../utils/id';
import { verifyChatOwnership } from '../services/chat-service';
import { createMessage } from '../services/message-service';

export const generateRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/generate
       * Unified endpoint: persists user message, generates image via the resolved
       * provider, persists AI message, and returns both.
       */
      .post(
        '/generate',
        async ({ body, set, user }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized', code: ERROR_CODES.UNAUTHORIZED };
          }
          const userId = user.id;
          const db = getDb();

          if (!(await verifyChatOwnership(body.chatId, userId, db))) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }

          // Resolve model: explicit or first available image model
          let model = body.model?.trim() || '';
          if (!model) {
            const catalog = await getUnifiedModelCatalog(userId);
            model = catalog.imageModels[0]?.modelId ?? '';
          }

          if (!model) {
            set.status = 503;
            return {
              error: 'No image model available. Configure a connector in Settings.',
              code: ERROR_CODES.PROVIDER_ERROR,
            };
          }

          const now = Date.now();

          // 1. Persist the user message
          const userMsgId = generateId();
          const userMessage = {
            id: userMsgId,
            chatId: body.chatId,
            role: 'user' as const,
            text: body.prompt,
            referenceImage: body.referenceImageUrl ?? null,
            timestamp: now,
            isGenerating: false,
          };

          await createMessage({ ...userMessage, interactionMode: 'image' }, db);

          // 2. Generate image via dynamic provider
          const aiMsgId = generateId();
          const startTime = Date.now();

          try {
            const provider = await getProviderForModel(model, userId);
            if (!provider.generateImage) {
              set.status = 422;
              return {
                error: 'This provider does not support image generation.',
                code: ERROR_CODES.PROVIDER_ERROR,
              };
            }
            const { imageUrl } = await provider.generateImage({
              userId,
              prompt: body.prompt,
              systemPrompt: body.systemPrompt,
              referenceImageUrl: body.referenceImageUrl,
              imageSize: body.imageQuality ?? '1K',
              modelName: model,
            });

            const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
            const styleParams = [body.imageQuality ?? '1K'];
            const aiTimestamp = Date.now();

            // 3. Persist the AI message with the generated image
            const aiMessage = {
              id: aiMsgId,
              chatId: body.chatId,
              role: 'ai' as const,
              text: '',
              imageUrl,
              timestamp: aiTimestamp,
              isGenerating: false,
              generationTime,
              modelName: model,
              styleParams,
            };

            await createMessage({ ...aiMessage, interactionMode: 'image' }, db);

            // Single chat update at the end to avoid updatedAt regression on concurrent requests
            await db
              .updateTable('chats')
              .set({ updatedAt: aiTimestamp, lastUsedMode: 'image' })
              .where('id', '=', body.chatId)
              .where('updatedAt', '<=', aiTimestamp)
              .execute();

            return {
              userMessage: {
                ...userMessage,
                referenceImage: userMessage.referenceImage ?? undefined,
              },
              aiMessage: {
                ...aiMessage,
              },
            };
          } catch (error: unknown) {
            console.error('[generate] Error:', error);
            set.status = 500;
            return {
              error: 'Image generation failed. Please try again.',
              code: ERROR_CODES.PROVIDER_ERROR,
            };
          }
        },
        {
          body: GenerateImageBodySchema,
        }
      )
  );
