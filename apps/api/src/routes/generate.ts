/**
 * Generate route: unified image generation endpoint.
 * Resolves the AI provider dynamically from the requested model.
 */

import { Elysia, t } from 'elysia';
import '../services/providers'; // ensure all providers are registered
import { getProviderForModel } from '../services/providers/registry';
import { getUnifiedModelCatalog } from '../services/providers/catalog';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { ptBR } from '@mangostudio/shared/i18n';

/** Generates a stable unique ID based on the current time + random suffix. */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

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
            return { error: ptBR.api.unauthorized };
          }
          const userId = user.id;
          const db = getDb();

          // Verify chat ownership
          const chat = await db
            .selectFrom('chats')
            .select('userId')
            .where('id', '=', body.chatId)
            .executeTakeFirst();

          if (!chat || chat.userId !== userId) {
            set.status = 404;
            return { error: 'Chat not found' };
          }

          // Resolve model: explicit or first available image model
          let model = body.model?.trim() || '';
          if (!model) {
            const catalog = await getUnifiedModelCatalog(userId);
            model = catalog.imageModels[0]?.modelId ?? '';
          }

          if (!model) {
            set.status = 503;
            return { error: 'No image model available. Configure a connector in Settings.' };
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

          await db
            .insertInto('messages')
            .values({
              id: userMessage.id,
              chatId: userMessage.chatId,
              role: userMessage.role,
              text: userMessage.text,
              referenceImage: userMessage.referenceImage,
              timestamp: userMessage.timestamp,
              isGenerating: 0,
              imageUrl: null,
              generationTime: null,
              modelName: null,
              styleParams: null,
              interactionMode: 'image',
            })
            .execute();

          // 2. Generate image via dynamic provider
          const aiMsgId = generateId();
          const startTime = Date.now();

          try {
            const provider = await getProviderForModel(model, userId);
            if (!provider.generateImage) {
              set.status = 422;
              return { error: 'This provider does not support image generation.' };
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

            await db
              .insertInto('messages')
              .values({
                id: aiMessage.id,
                chatId: aiMessage.chatId,
                role: aiMessage.role,
                text: aiMessage.text,
                imageUrl: aiMessage.imageUrl,
                timestamp: aiMessage.timestamp,
                isGenerating: 0,
                referenceImage: null,
                generationTime: aiMessage.generationTime,
                modelName: aiMessage.modelName,
                styleParams: JSON.stringify(aiMessage.styleParams),
                interactionMode: 'image',
              })
              .execute();

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
          } catch (error: any) {
            console.error('[generate] Error:', error.message);
            const errorText = error?.message || 'Image generation failed';
            set.status = 500;
            return { error: errorText };
          }
        },
        {
          body: t.Object({
            chatId: t.String(),
            prompt: t.String(),
            systemPrompt: t.Optional(t.String()),
            referenceImageUrl: t.Optional(t.String()),
            imageQuality: t.Optional(t.String()),
            model: t.Optional(t.String()),
          }),
        }
      )
  );
