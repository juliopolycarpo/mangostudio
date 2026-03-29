/**
 * Streaming respond route: text chat endpoint using SSE.
 * Streams the AI response incrementally via Server-Sent Events.
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

          await db
            .updateTable('chats')
            .set({ updatedAt: now, lastUsedMode: 'chat' })
            .where('id', '=', body.chatId)
            .execute();

          // 2. Load prior chat-mode messages for context reconstruction
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

          // 3. Stream AI response as SSE
          const aiMsgId = generateId();
          const startTime = Date.now();
          const provider = getProvider('gemini');

          // Capture context before the async boundary inside ReadableStream
          const userId = user?.id ?? '';
          const chatId = body.chatId;
          const prompt = body.prompt;
          const systemPrompt = body.systemPrompt;

          const stream = new ReadableStream({
            async start(controller) {
              let fullText = '';

              try {
                if (provider.generateTextStream) {
                  for await (const chunk of provider.generateTextStream({
                    userId,
                    history,
                    prompt,
                    systemPrompt,
                    modelName: model,
                  })) {
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
                  });
                  fullText = result.text;
                  controller.enqueue(sseEvent({ text: fullText, done: false }));
                }

                const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
                const aiTimestamp = Date.now();

                // Persist the completed AI message
                await db
                  .insertInto('messages')
                  .values({
                    id: aiMsgId,
                    chatId,
                    role: 'ai',
                    text: fullText,
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

                await db
                  .updateTable('chats')
                  .set({ updatedAt: aiTimestamp })
                  .where('id', '=', chatId)
                  .execute();

                controller.enqueue(sseEvent({ done: true, messageId: aiMsgId, generationTime }));
              } catch (error: any) {
                console.error('[respond-stream] Error:', error.message);
                controller.enqueue(
                  sseEvent({ error: error?.message ?? 'Stream generation failed', done: true })
                );
              } finally {
                controller.close();
              }
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
