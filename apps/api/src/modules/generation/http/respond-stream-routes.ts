/**
 * SSE streaming route: thin transport adapter over stream-text-turn.
 * Responsible for pre-flight HTTP errors, SSE framing, heartbeats, abort handling,
 * and error serialization.
 */

import { type Elysia } from 'elysia';
import { RespondStreamBodySchema } from '@mangostudio/shared/generation';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import '../../../services/providers'; // ensure all providers are registered
import '../../../services/tools'; // ensure all builtins are registered
import { getDb } from '../../../db/database';
import { requireAuth } from '../../../plugins/auth-middleware';
import { verifyChatOwnership } from '../../chats/infrastructure/chat-repository';
import { resolveModel, NoModelAvailableError } from '../application/resolve-model';
import { getProviderForModel } from '../../../services/providers/registry';
import { streamTextTurn, type StreamEvent } from '../application/stream-text-turn';

const KEEPALIVE_INTERVAL_MS = 15_000;

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

function toSsePayload(event: StreamEvent): object {
  switch (event.type) {
    case 'user_message_id':
      return { type: 'user_message_id', messageId: event.messageId, done: false };
    case 'thinking_start':
      return { type: 'thinking_start', done: false };
    case 'thinking':
      return { type: 'thinking', text: event.text, done: false };
    case 'text':
      return { type: 'text', text: event.text, done: false };
    case 'tool_call_started':
      return { type: 'tool_call_started', callId: event.callId, name: event.name, done: false };
    case 'tool_call_completed':
      return {
        type: 'tool_call_completed',
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
        done: false,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        callId: event.callId,
        name: event.name,
        result: event.result,
        isError: event.isError,
        done: false,
      };
    case 'fallback_notice':
      return { type: 'fallback_notice', from: event.from, to: event.to, reason: event.reason };
    case 'system_event':
      return { type: 'system_event', event: event.event, detail: event.detail, done: false };
    case 'context_info':
      return {
        type: 'context_info',
        estimatedInputTokens: event.estimatedInputTokens,
        contextLimit: event.contextLimit,
        estimatedUsageRatio: event.estimatedUsageRatio,
        mode: event.mode,
        severity: event.severity,
      };
    case 'done':
      return {
        type: 'done',
        done: true,
        messageId: event.messageId,
        generationTime: event.generationTime,
      };
    case 'error': {
      const errorEvent: SSEErrorEvent = { type: 'error', error: event.error, done: true };
      return errorEvent;
    }
  }
}

export const respondStreamRoutes = (app: Elysia) =>
  app.group('', (app) =>
    app
      .use(requireAuth)
      /**
       * POST /api/respond/stream
       * Pre-flight checks return HTTP errors before SSE headers are committed.
       * Afterwards, wraps streamTextTurn generator as SSE frames.
       */
      .post(
        '/respond/stream',
        async ({ body, set, user }) => {
          const userId = user?.id ?? '';
          const db = getDb();

          // Ownership check must be pre-flight to return HTTP 404 before SSE headers flush.
          if (!(await verifyChatOwnership(body.chatId, userId, db))) {
            set.status = 404;
            return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
          }

          // Model resolution must be pre-flight to return HTTP 503 before SSE headers flush.
          let resolvedModel: string;
          try {
            const { modelId } = await resolveModel({
              requestedModel: body.model,
              userId,
              type: 'text',
            });
            resolvedModel = modelId;
          } catch (err) {
            if (err instanceof NoModelAvailableError) {
              set.status = 503;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
            }
            throw err;
          }

          // Provider lookup must be pre-flight to return HTTP 400 before SSE headers flush.
          try {
            await getProviderForModel(resolvedModel, userId);
          } catch {
            set.status = 400;
            return {
              error: 'No provider available for the requested model.',
              code: ERROR_CODES.PROVIDER_ERROR,
            };
          }

          const abortController = new AbortController();

          const stream = new ReadableStream({
            async start(controller) {
              const heartbeat = setInterval(() => {
                try {
                  controller.enqueue(KEEPALIVE_BYTES);
                } catch {
                  // Controller may already be closed
                }
              }, KEEPALIVE_INTERVAL_MS);

              try {
                for await (const event of streamTextTurn(
                  {
                    chatId: body.chatId,
                    userId,
                    prompt: body.prompt,
                    model: resolvedModel,
                    systemPrompt: body.systemPrompt,
                    thinkingEnabled: body.thinkingEnabled ?? body.thinkingVisibility !== 'off',
                    reasoningEffort: body.reasoningEffort,
                    signal: abortController.signal,
                  },
                  db
                )) {
                  if (abortController.signal.aborted) break;
                  controller.enqueue(sseEvent(toSsePayload(event)));
                }
              } catch (err) {
                if (!abortController.signal.aborted) {
                  const message = err instanceof Error ? err.message : 'Stream generation failed';
                  const errorEvent: SSEErrorEvent = { type: 'error', error: message, done: true };
                  controller.enqueue(sseEvent(errorEvent));
                }
              } finally {
                clearInterval(heartbeat);
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
        { body: RespondStreamBodySchema }
      )
  );
