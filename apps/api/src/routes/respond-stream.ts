/**
 * Streaming respond route: text chat endpoint using SSE.
 * Streams the AI response incrementally via Server-Sent Events.
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
import type { SSEErrorEvent } from '@mangostudio/shared';

/** Serialises an SSE data line. */
function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export const respondStreamRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/respond/stream
       * Streaming text-chat endpoint: persists user message, reconstructs context,
       * calls the AI provider stream, and pushes SSE events until done.
       * Falls back to single-event response when the provider lacks streaming support.
       *
       * SSE event shapes:
       *   chunk:  { text: string; done: false }
       *   done:   { done: true; messageId: string; generationTime: string }
       *   error:  { error: string; done: true }
       */
      .post(
        '/respond/stream',
        async ({ body, set, user }) => {
          if (!user?.id) {
            set.status = 401;
            return { error: 'Unauthorized' };
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

          // 2. Load prior chat-mode messages for context reconstruction
          // updatedAt will be written once after AI response to avoid regression on concurrent requests
          const history = await loadChatHistory(body.chatId, { excludeId: userMsgId }, db);

          // 3. Stream AI response as SSE
          const aiMsgId = generateId();
          const startTime = Date.now();
          const provider = await getProviderForModel(model, userId);

          // Capture context before the async boundary inside ReadableStream
          const chatId = body.chatId;
          const prompt = body.prompt;
          const systemPrompt = body.systemPrompt;

          const abortController = new AbortController();
          const { signal } = abortController;

          const stream = new ReadableStream({
            async start(controller) {
              let fullText = '';
              let aborted = false;

              try {
                if (provider.generateTextStream) {
                  for await (const chunk of provider.generateTextStream({
                    userId,
                    history,
                    prompt,
                    systemPrompt,
                    modelName: model,
                    signal,
                  })) {
                    if (signal.aborted) {
                      aborted = true;
                      break;
                    }
                    if (!chunk.done && chunk.text) {
                      fullText += chunk.text;
                      controller.enqueue(sseEvent({ text: chunk.text, done: false }));
                    }
                  }
                } else {
                  // Fallback: generate all at once, emit as single chunk
                  const result = await provider.generateText({
                    userId,
                    history,
                    prompt,
                    systemPrompt,
                    modelName: model,
                    signal,
                  });
                  if (signal.aborted) {
                    aborted = true;
                  } else {
                    fullText = result.text;
                    controller.enqueue(sseEvent({ text: fullText, done: false }));
                  }
                }

                if (!aborted) {
                  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
                  const aiTimestamp = Date.now();

                  // Persist the completed AI message
                  await createMessage(
                    {
                      id: aiMsgId,
                      chatId,
                      role: 'ai',
                      text: fullText,
                      timestamp: aiTimestamp,
                      isGenerating: false,
                      generationTime,
                      modelName: model,
                      interactionMode: 'chat',
                    },
                    db
                  );

                  // Single update with WHERE guard to prevent updatedAt from regressing
                  await db
                    .updateTable('chats')
                    .set({ updatedAt: aiTimestamp, lastUsedMode: 'chat' })
                    .where('id', '=', chatId)
                    .where('updatedAt', '<=', aiTimestamp)
                    .execute();

                  controller.enqueue(sseEvent({ done: true, messageId: aiMsgId, generationTime }));
                }
              } catch (error: unknown) {
                if (signal.aborted) {
                  // Client disconnected — generation cancelled, nothing to persist
                  return;
                }
                const message = error instanceof Error ? error.message : 'Stream generation failed';
                console.error('[respond-stream] Error:', message);
                const errorEvent: SSEErrorEvent = { error: message, done: true };
                controller.enqueue(sseEvent(errorEvent));
              } finally {
                controller.close();
              }
            },
            cancel() {
              abortController.abort();
            },
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
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
