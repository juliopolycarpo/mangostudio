/**
 * Respond route: text chat endpoint.
 */

import { Elysia, t } from 'elysia';
import { getDefaultTextModel, getGeminiModelCatalog, hasTextModel } from '../services/gemini';
import '../services/providers'; // ensure GeminiProvider is registered
import { getProvider } from '../services/providers/registry';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';

/** Generates a stable unique ID based on the current time + random suffix. */
function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export const respondRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/respond
       * Text-chat endpoint: persists user message, reconstructs chat context from history,
       * calls Gemini text model, persists AI reply, and returns both messages.
       */
      .post(
        '/respond',
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
          const model = body.model?.trim() || getDefaultTextModel(user?.id ?? '');

          if (!model) {
            set.status = 503;
            return { error: 'No Gemini text model is currently available for this API key.' };
          }

          if (modelCatalog.status !== 'ready') {
            set.status = 503;
            return {
              error:
                'Gemini model catalog is unavailable right now. Refresh Settings and try again.',
            };
          }

          if (!hasTextModel(user?.id ?? '', model)) {
            set.status = 422;
            return { error: 'Selected Gemini model is no longer available for this API key.' };
          }

          // 1. Persist the user text message
          const userMsgId = generateId();
          await db
            .insertInto('messages')
            .values({
              id: userMsgId,
              chatId: body.chatId,
              role: 'user',
              text: body.prompt,
              imageUrl: null,
              referenceImage: null,
              timestamp: now,
              isGenerating: 0,
              generationTime: null,
              modelName: null,
              styleParams: null,
              interactionMode: 'chat',
            })
            .execute();

          // Update chat's updatedAt and lastUsedMode
          await db
            .updateTable('chats')
            .set({ updatedAt: now, lastUsedMode: 'chat' })
            .where('id', '=', body.chatId)
            .execute();

          // 2. Load prior chat-mode messages for context reconstruction (exclude the one just saved)
          const historyRows = await db
            .selectFrom('messages')
            .select(['id', 'role', 'text'])
            .where('chatId', '=', body.chatId)
            .where('interactionMode', '=', 'chat')
            .where('id', '!=', userMsgId)
            .orderBy('timestamp', 'asc')
            .execute();

          const history = historyRows.map((row) => ({
            role: row.role as 'user' | 'ai',
            text: row.text,
          }));

          // 3. Generate text response
          const aiMsgId = generateId();
          const startTime = Date.now();

          try {
            const provider = getProvider('gemini');
            const result = await provider.generateText({
              userId: user?.id ?? '',
              history,
              prompt: body.prompt,
              systemPrompt: body.systemPrompt,
              modelName: model,
            });
            const responseText = result.text;

            const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
            const aiTimestamp = Date.now();

            // 4. Persist the AI text reply
            await db
              .insertInto('messages')
              .values({
                id: aiMsgId,
                chatId: body.chatId,
                role: 'ai',
                text: responseText,
                imageUrl: null,
                referenceImage: null,
                timestamp: aiTimestamp,
                isGenerating: 0,
                generationTime,
                modelName: model,
                styleParams: null,
                interactionMode: 'chat',
              })
              .execute();

            // Update chat's updatedAt
            await db
              .updateTable('chats')
              .set({ updatedAt: aiTimestamp })
              .where('id', '=', body.chatId)
              .execute();

            return {
              userMessage: {
                id: userMsgId,
                chatId: body.chatId,
                role: 'user' as const,
                text: body.prompt,
                timestamp: now,
                isGenerating: false,
                interactionMode: 'chat' as const,
              },
              aiMessage: {
                id: aiMsgId,
                chatId: body.chatId,
                role: 'ai' as const,
                text: responseText,
                timestamp: aiTimestamp,
                isGenerating: false,
                generationTime,
                modelName: model,
                interactionMode: 'chat' as const,
              },
            };
          } catch (error: any) {
            console.error('[respond] Error:', error.message);
            const errorText = error?.message ?? 'Text generation failed';
            set.status = 500;
            return { error: errorText };
          }
        },
        {
          body: t.Object({
            chatId: t.String(),
            prompt: t.String(),
            model: t.Optional(t.String()),
            systemPrompt: t.Optional(t.String()),
          }),
        }
      )
  );
