/**
 * Respond route: text chat endpoint.
 * Resolves the AI provider dynamically from the requested model.
 */

import { Elysia, t } from 'elysia';
import '../services/providers'; // ensure all providers are registered
import { getProviderForModel } from '../services/providers/registry';
import { getUnifiedModelCatalog } from '../services/providers/catalog';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { generateId } from '../utils/id';
import { verifyChatOwnership } from '../services/chat-service';
import { createMessage, loadChatHistory } from '../services/message-service';
import { ptBR } from '@mangostudio/shared/i18n';

export const respondRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/respond
       * Text-chat endpoint: persists user message, reconstructs chat context from history,
       * calls the resolved AI provider, persists AI reply, and returns both messages.
       */
      .post(
        '/respond',
        async ({ body, set, user }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: ptBR.api.unauthorized };
          }
          const userId = user.id;
          const db = getDb();

          if (!(await verifyChatOwnership(body.chatId, userId, db))) {
            set.status = 404;
            return { error: 'Chat not found' };
          }

          // Resolve model: explicit or first available from unified catalog
          let model = body.model?.trim() || '';
          if (!model) {
            const catalog = await getUnifiedModelCatalog(userId);
            model = catalog.textModels[0]?.modelId ?? '';
          }

          if (!model) {
            set.status = 503;
            return { error: 'No text model available. Configure a connector in Settings.' };
          }

          const now = Date.now();

          // 1. Persist the user text message
          const userMsgId = generateId();
          await createMessage(
            {
              id: userMsgId,
              chatId: body.chatId,
              role: 'user',
              text: body.prompt,
              timestamp: now,
              isGenerating: false,
              interactionMode: 'chat',
            },
            db
          );

          // 2. Load prior chat-mode messages for context reconstruction (exclude the one just saved)
          const history = await loadChatHistory(body.chatId, { excludeId: userMsgId }, db);

          // 3. Generate text response via dynamic provider
          const aiMsgId = generateId();
          const startTime = Date.now();

          try {
            const provider = await getProviderForModel(model, userId);
            const result = await provider.generateText({
              userId,
              history,
              prompt: body.prompt,
              systemPrompt: body.systemPrompt,
              modelName: model,
            });
            const responseText = result.text;

            const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
            const aiTimestamp = Date.now();

            // 4. Persist the AI text reply
            await createMessage(
              {
                id: aiMsgId,
                chatId: body.chatId,
                role: 'ai',
                text: responseText,
                timestamp: aiTimestamp,
                isGenerating: false,
                generationTime,
                modelName: model,
                interactionMode: 'chat',
              },
              db
            );

            // Single chat update at the end to avoid updatedAt regression on concurrent requests
            await db
              .updateTable('chats')
              .set({ updatedAt: aiTimestamp, lastUsedMode: 'chat' })
              .where('id', '=', body.chatId)
              .where('updatedAt', '<=', aiTimestamp)
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
