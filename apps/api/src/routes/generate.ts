/**
 * Generate route: unified image generation endpoint.
 */

import { Elysia, t } from 'elysia';
import {
  generateImage,
  getDefaultImageModel,
  getGeminiModelCatalog,
  hasImageModel,
} from '../services/gemini';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';

/** Generates a stable unique ID based on the current time + random suffix. */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const generateRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app.use(requireAuth)
  /**
   * POST /api/generate
   * Unified endpoint: persists user message, generates image via Gemini,
   * persists AI message, and returns both.
   */
  .post(
    '/generate',
    async ({ body, set, user }) => {
      const db = getDb();
      
      // Verify chat ownership
      const chat = await db
        .selectFrom('chats')
        .select('userId')
        .where('id', '=', body.chatId)
        .executeTakeFirst();
      
      if (!chat || chat.userId !== (user?.id ?? '')) {
        set.status = 404;
        return { error: 'Chat not found' };
      }

      const now = Date.now();
      const modelCatalog = await getGeminiModelCatalog(user?.id ?? '');
      const model = body.model?.trim() || getDefaultImageModel(user?.id ?? '');

      if (!model) {
        set.status = 503;
        return { error: 'No Gemini image model is currently available for this API key.' };
      }

      if (modelCatalog.status !== 'ready') {
        set.status = 503;
        return {
          error: 'Gemini model catalog is unavailable right now. Refresh Settings and try again.',
        };
      }

      if (!hasImageModel(user?.id ?? '', model)) {
        set.status = 422;
        return { error: 'Selected Gemini model is no longer available for this API key.' };
      }

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

      // Update chat's updatedAt and lastUsedMode
      await db
        .updateTable('chats')
        .set({ updatedAt: now, lastUsedMode: 'image' })
        .where('id', '=', body.chatId)
        .execute();

      // 2. Generate image via Gemini
      const aiMsgId = generateId();
      const startTime = Date.now();

      try {
        const imageUrl = await generateImage(
          user?.id ?? '',
          body.prompt,
          body.systemPrompt,
          body.referenceImageUrl,
          body.imageQuality ?? '1K',
          model
        );

        const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        const styleParams = [
          'Cinematic',
          `${body.imageQuality ?? '1K'} Detail`,
          model === 'gemini-3-pro-image-preview' ? 'Pro' : 'Vivid',
        ];

        // 3. Persist the AI message with the generated image
        const aiMessage = {
          id: aiMsgId,
          chatId: body.chatId,
          role: 'ai' as const,
          text: '',
          imageUrl,
          timestamp: Date.now(),
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

        // Update chat's updatedAt again with the final timestamp
        await db
          .updateTable('chats')
          .set({ updatedAt: aiMessage.timestamp })
          .where('id', '=', body.chatId)
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
  ));
