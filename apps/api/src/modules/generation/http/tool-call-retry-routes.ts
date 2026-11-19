/**
 * `POST /chats/:id/messages/:messageId/tool-calls/:callId/retry`
 *
 * The user's retry of one settled tool call. Refusals are plain HTTP errors
 * decided before the stream opens; an accepted retry answers as SSE (the call
 * can outlive the hub's idle timeout) and appends its result to the original
 * assistant message. See `tool-call-retry.ts` for what runs.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import { RetryToolCallBodySchema } from '@mangostudio/shared/tool-executions';
import { type Elysia, t } from 'elysia';

import { getDb } from '../../../db/database';
import { apiErrorStatus } from '../../../lib/api-error-status';
import {
  environmentUnavailableBody,
  environmentUnavailableResponse,
} from '../../../lib/environment-unavailable';
import { getErrorCode } from '../../../lib/error-code';
import { SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_INTERVAL_MS } from '../../../lib/hub-connection-limits';
import { requireAuth } from '../../../plugins/auth-middleware';
import { registerActiveTurn } from '../application/active-turn-registry';
import {
  reserveToolCallRetry,
  runToolCallRetry,
  ToolCallRetryConfirmationRequiredError,
  ToolCallRetryConflictError,
  ToolCallRetryNotFoundError,
} from '../application/tool-call-retry';
import { sseEvent, toSsePayload } from './turn-sse-events';

export const toolCallRetryRoutes = (app: Elysia) =>
  app.group('/chats/:id/messages/:messageId/tool-calls/:callId', (app) =>
    app.use(requireAuth).post(
      '/retry',
      {
        params: t.Object({ id: t.String(), messageId: t.String(), callId: t.String() }),
        body: RetryToolCallBodySchema,
      },
      async ({ params, body, user, set }) => {
        const userId = user?.id ?? '';
        const db = getDb();
        const abortController = new AbortController();
        // Set only by a registration this request won; the release it holds
        // removes that entry and never another request's for the same message.
        let releaseTurn: (() => void) | null = null;
        const unregisterTurn = () => {
          releaseTurn?.();
          releaseTurn = null;
        };

        let reserved: Awaited<ReturnType<typeof reserveToolCallRetry>>;
        try {
          reserved = await reserveToolCallRetry(
            {
              chatId: params.id,
              messageId: params.messageId,
              callId: params.callId,
              userId,
              confirmed: body.confirmed === true,
              onTurnReserved: (messageId) => {
                releaseTurn = registerActiveTurn(messageId, {
                  userId,
                  chatId: params.id,
                  abort: (reasonCode) => abortController.abort(reasonCode),
                });
              },
            },
            db
          );
        } catch (error) {
          unregisterTurn();
          if (error instanceof ToolCallRetryNotFoundError) {
            return apiErrorStatus(404, { error: error.message, code: ERROR_CODES.NOT_FOUND });
          }
          if (error instanceof ToolCallRetryConflictError) {
            return apiErrorStatus(409, { error: error.message, code: ERROR_CODES.CONFLICT });
          }
          if (error instanceof ToolCallRetryConfirmationRequiredError) {
            return apiErrorStatus(400, { error: error.message, code: ERROR_CODES.VALIDATION });
          }
          const unavailable = environmentUnavailableResponse(error, set);
          if (unavailable) return unavailable;
          throw error;
        }

        // Only the stream's own `cancel()` means the browser is gone and
        // `controller.enqueue` would throw; see respond-stream-routes.
        let clientDisconnected = false;
        const stream = new ReadableStream({
          async start(controller) {
            const heartbeat = setInterval(() => {
              try {
                controller.enqueue(SSE_KEEPALIVE_FRAME);
              } catch {
                // Controller may already be closed
              }
            }, SSE_KEEPALIVE_INTERVAL_MS);

            try {
              for await (const event of runToolCallRetry(reserved, db, abortController.signal)) {
                if (!clientDisconnected) controller.enqueue(sseEvent(toSsePayload(event)));
              }
            } catch (err) {
              if (!abortController.signal.aborted) {
                const unavailable = environmentUnavailableBody(err);
                const code = unavailable?.code ?? getErrorCode(err);
                const errorEvent: SSEErrorEvent = {
                  type: 'error',
                  error:
                    unavailable?.error ?? (err instanceof Error ? err.message : 'Retry failed'),
                  ...(code ? { code } : {}),
                  done: true,
                };
                controller.enqueue(sseEvent(errorEvent));
              }
            } finally {
              clearInterval(heartbeat);
              unregisterTurn();
              try {
                controller.close();
              } catch {
                // The browser may already have cancelled the stream.
              }
            }
          },
          cancel() {
            clientDisconnected = true;
            abortController.abort('client_disconnect');
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }
    )
  );
