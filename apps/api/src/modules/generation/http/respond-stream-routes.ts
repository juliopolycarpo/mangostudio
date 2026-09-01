/**
 * SSE streaming route: thin transport adapter over stream-text-turn.
 * Responsible for pre-flight HTTP errors, SSE framing, heartbeats, abort handling,
 * and error serialization.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import { RespondStreamBodySchema } from '@mangostudio/shared/generation';
import type { SSEErrorEvent } from '@mangostudio/shared/streaming';
import type { Elysia } from 'elysia';
import { getDb } from '../../../db/database';
import { getErrorCode } from '../../../lib/error-code';
import { requireAuth } from '../../../plugins/auth-middleware';
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import { AgentSettingsError } from '../../agents/domain/agent-profile';
import {
  assertChatAttachmentIdsAvailable,
  ChatAttachmentNotFoundError,
} from '../../attachments/infrastructure/attachment-repository';
import { getOwnedChat } from '../../chats/infrastructure/chat-repository';
import { streamExternalTurn } from '../../external-agents/application/external-turn-stream';
import {
  EXTERNAL_PREFLIGHT_CODE,
  EXTERNAL_PREFLIGHT_STATUS,
  externalPreflightDetails,
} from '../../external-agents/http/external-preflight';
import { registerActiveTurn, unregisterActiveTurn } from '../application/active-turn-registry';
import {
  NoModelAvailableError,
  type ResolvedModel,
  resolveModel,
} from '../application/resolve-model';
import {
  type ResolvedRunnerAgent,
  resolveRunnerAgentProfile,
} from '../application/resolve-runner-agent';
import { KEEPALIVE_INTERVAL_MS } from '../application/sse-keepalive';
import { type StreamEvent, streamTextTurn } from '../application/stream-text-turn';
import {
  assertTextTurnHasContent,
  EmptyTextTurnError,
  normalizeTextTurnAttachmentIds,
} from '../application/text-turn-content';
import {
  inspectInterruptedTurnResume,
  reserveInterruptedTurnResume,
  TurnRecoveryConflictError,
  TurnRecoveryNotFoundError,
  TurnRecoveryValidationError,
} from '../application/turn-recovery';
import { modelUnavailableResponse } from './model-unavailable-response';

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

function toSsePayload(event: StreamEvent): object {
  switch (event.type) {
    case 'user_message_id':
      return { type: 'user_message_id', messageId: event.messageId, done: false };
    case 'assistant_message_id':
      return { type: 'assistant_message_id', messageId: event.messageId, done: false };
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
    case 'tool_execution':
      return {
        type: 'tool_execution',
        callId: event.callId,
        name: event.name,
        execution: event.execution,
        done: false,
      };
    case 'subagent_started':
      return {
        type: 'subagent_started',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        task: event.task,
        done: false,
      };
    case 'subagent_text':
      return {
        type: 'subagent_text',
        callId: event.callId,
        agentId: event.agentId,
        text: event.text,
        done: false,
      };
    case 'subagent_tool_call_started':
      return {
        type: 'subagent_tool_call_started',
        callId: event.callId,
        agentId: event.agentId,
        toolCallId: event.toolCallId,
        name: event.name,
        done: false,
      };
    case 'subagent_completed':
      return {
        type: 'subagent_completed',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        summary: event.summary,
        toolCallCount: event.toolCallCount,
        done: false,
      };
    case 'subagent_failed':
      return {
        type: 'subagent_failed',
        callId: event.callId,
        agentId: event.agentId,
        agentName: event.agentName,
        error: event.error,
        done: false,
      };
    case 'image_generation_started':
      return {
        type: 'image_generation_started',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        done: false,
      };
    case 'image_generation_completed':
      return {
        type: 'image_generation_completed',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        imageUrl: event.imageUrl,
        modelName: event.modelName,
        generationTime: event.generationTime,
        done: false,
      };
    case 'image_generation_failed':
      return {
        type: 'image_generation_failed',
        imageId: event.imageId,
        toolCallId: event.toolCallId,
        prompt: event.prompt,
        error: event.error,
        modelName: event.modelName,
        generationTime: event.generationTime,
        done: false,
      };
    case 'question':
      return {
        type: 'question',
        toolCallId: event.part.toolCallId,
        questions: event.part.questions,
        done: false,
      };
    case 'mcp_elicitation':
      return {
        type: 'mcp_elicitation_request',
        elicitationId: event.part.elicitationId,
        toolCallId: event.part.toolCallId,
        serverSlug: event.part.serverSlug,
        message: event.part.message,
        fields: event.part.fields,
        status: event.part.status,
        done: false,
      };
    case 'mcp_elicitation_status':
      return {
        type: 'mcp_elicitation_status',
        elicitationId: event.elicitationId,
        toolCallId: event.toolCallId,
        status: event.status,
        reason: event.reason,
        done: false,
      };
    case 'todo_update':
      return {
        type: 'todo_update',
        toolCallId: event.part.toolCallId,
        todos: event.part.todos,
        done: false,
      };
    case 'mcp_media':
      return {
        type: 'mcp_media',
        toolCallId: event.part.toolCallId,
        serverSlug: event.part.serverSlug,
        toolName: event.part.toolName,
        kind: event.part.kind,
        mimeType: event.part.mimeType,
        url: event.part.url,
        uri: event.part.uri,
        done: false,
      };
    case 'fallback_notice':
      return {
        type: 'fallback_notice',
        from: event.from,
        to: event.to,
        reason: event.reason,
        done: false,
      };
    case 'continuation_transition':
      return {
        type: 'continuation_transition',
        provider: event.provider,
        modelName: event.modelName,
        fromProvider: event.fromProvider,
        fromMode: event.fromMode,
        toMode: event.toMode,
        reasonCode: event.reasonCode,
        detail: event.detail,
        done: false,
      };
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
        done: false,
      };
    case 'done':
      return {
        type: 'done',
        done: true,
        messageId: event.messageId,
        generationTime: event.generationTime,
      };
    case 'error': {
      const errorEvent: SSEErrorEvent = {
        type: 'error',
        error: event.error,
        ...(event.code ? { code: event.code } : {}),
        done: true,
      };
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
      .post('/respond/stream', { body: RespondStreamBodySchema }, async ({ body, set, user }) => {
        const userId = user?.id ?? '';
        const db = getDb();

        // Ownership check must be pre-flight to return HTTP 404 before SSE
        // headers flush. The same read supplies the persisted runner, which
        // names the agent when the request does not.
        const ownedChat = await getOwnedChat(body.chatId, userId, db);
        if (!ownedChat) {
          set.status = 404;
          return { error: 'Chat not found', code: ERROR_CODES.NOT_FOUND };
        }

        const attachmentIds = normalizeTextTurnAttachmentIds(body.attachmentIds);
        try {
          assertTextTurnHasContent(body.prompt, attachmentIds);
          await assertChatAttachmentIdsAvailable(
            { attachmentIds, userId, chatId: body.chatId },
            db
          );
        } catch (err) {
          if (err instanceof ChatAttachmentNotFoundError || err instanceof EmptyTextTurnError) {
            set.status = 400;
            return { error: err.message, code: ERROR_CODES.VALIDATION };
          }
          throw err;
        }

        // Before the model, agent and provider preflight below, not after. An
        // external turn resolves no MangoStudio model, so running that first
        // answers a chat that needs no model with `NoModelAvailableError` —
        // a 503 about a provider the user never chose.
        if (ownedChat.runner.kind === 'external') {
          const result = await streamExternalTurn(
            {
              userId,
              chat: ownedChat,
              chatId: body.chatId,
              prompt: body.prompt,
              attachmentIds,
              externalTurn: body.externalTurn,
            },
            db
          );
          if (result.ok) return result.response;
          set.status = EXTERNAL_PREFLIGHT_STATUS[result.failure.kind];
          return {
            error: result.failure.message,
            code: EXTERNAL_PREFLIGHT_CODE[result.failure.kind],
            // The disclosure has to name what gets loaded, and only the
            // machine that runs the vendor can spell the directory it will
            // read. The client renders this; it never composes one. The
            // vendor and machine travel with it so the grant that follows can
            // be checked against the scope this refusal disclosed — and the
            // acknowledgement is recorded against a specific machine's
            // descriptor, so a client that only learned "a disclosure is
            // required" could not record one.
            ...externalPreflightDetails(result.failure),
          };
        }

        let inspectedRecovery: Awaited<ReturnType<typeof inspectInterruptedTurnResume>> | null =
          null;
        if (body.recovery) {
          try {
            inspectedRecovery = await inspectInterruptedTurnResume(
              { chatId: body.chatId, userId, recovery: body.recovery },
              db
            );
          } catch (err) {
            if (err instanceof TurnRecoveryNotFoundError) {
              set.status = 404;
              return { error: err.message, code: ERROR_CODES.NOT_FOUND };
            }
            if (err instanceof TurnRecoveryConflictError) {
              set.status = 409;
              return { error: err.message, code: ERROR_CODES.CONFLICT };
            }
            if (err instanceof TurnRecoveryValidationError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            throw err;
          }
        }

        // Model resolution must be pre-flight to return HTTP 503 before SSE headers flush.
        let resolvedModel: ResolvedModel;
        let resolvedAgent: ResolvedRunnerAgent;
        try {
          resolvedAgent = await resolveRunnerAgentProfile({
            db,
            userId,
            runner: ownedChat.runner,
            agentId: inspectedRecovery?.agentId ?? body.agentId,
          });
          resolvedModel = await resolveModel({
            requestedModel:
              inspectedRecovery?.modelName ?? body.model ?? resolvedAgent.profile.model,
            userId,
            type: 'text',
          });
        } catch (err) {
          if (err instanceof AgentSettingsError && err.status === 404) {
            set.status = 404;
            return { error: 'Agent not found', code: ERROR_CODES.NOT_FOUND };
          }
          if (err instanceof NoModelAvailableError) {
            const refusal = modelUnavailableResponse(err);
            set.status = refusal.status;
            return refusal.body;
          }
          throw err;
        }

        // Provider lookup must be pre-flight to return HTTP 400 before SSE headers flush.
        try {
          if (resolvedModel.providerType) {
            getProvider(resolvedModel.providerType);
          } else {
            await getProviderForModel(resolvedModel.modelId, userId);
          }
        } catch {
          set.status = 400;
          return {
            error: 'No provider available for the requested model.',
            code: ERROR_CODES.PROVIDER_ERROR,
          };
        }

        const abortController = new AbortController();
        let activeAssistantMessageId: string | null = null;
        const registerTurn = (messageId: string) => {
          activeAssistantMessageId = messageId;
          registerActiveTurn(messageId, {
            userId,
            chatId: body.chatId,
            abort: (reasonCode) => abortController.abort(reasonCode),
          });
        };
        const unregisterTurn = () => {
          if (!activeAssistantMessageId) return;
          unregisterActiveTurn(activeAssistantMessageId);
          activeAssistantMessageId = null;
        };

        let reservedRecovery: Awaited<ReturnType<typeof reserveInterruptedTurnResume>> | null =
          null;
        if (body.recovery && inspectedRecovery) {
          try {
            reservedRecovery = await reserveInterruptedTurnResume(
              {
                chatId: body.chatId,
                userId,
                displayPrompt: body.prompt,
                attachmentIds,
                recovery: body.recovery,
                inspected: inspectedRecovery,
                resolvedModel,
                agentId: resolvedAgent.agentId,
                agentName: resolvedAgent.profile.name,
                onTurnReserved: registerTurn,
              },
              db
            );
          } catch (err) {
            unregisterTurn();
            if (err instanceof TurnRecoveryNotFoundError) {
              set.status = 404;
              return { error: err.message, code: ERROR_CODES.NOT_FOUND };
            }
            if (err instanceof TurnRecoveryConflictError) {
              set.status = 409;
              return { error: err.message, code: ERROR_CODES.CONFLICT };
            }
            if (err instanceof TurnRecoveryValidationError) {
              set.status = 400;
              return { error: err.message, code: ERROR_CODES.VALIDATION };
            }
            throw err;
          }
        }

        // `abortController.signal.aborted` also goes true for an in-place Stop
        // (`cancelActiveTurn` aborts the same signal from a separate request),
        // which leaves this connection open and its controller writable. Only
        // the ReadableStream's own `cancel()` means the browser is gone and
        // `controller.enqueue` would throw, so trailing events a cancelled
        // turn still yields — like `image_generation_failed` for the images it
        // never reached — must gate on this instead of the abort signal.
        let clientDisconnected = false;

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
                  prompt: reservedRecovery?.effectivePrompt ?? body.prompt,
                  attachmentIds,
                  model: resolvedModel.modelId,
                  systemPrompt: body.systemPrompt,
                  promptSettings: body.promptSettings,
                  thinkingEnabled: body.thinkingEnabled ?? body.thinkingVisibility !== 'off',
                  reasoningEffort: body.reasoningEffort,
                  maxToolIterations: body.maxToolIterations,
                  contextSettings: body.contextSettings,
                  toolIntent: body.toolIntent,
                  agentId: resolvedAgent.agentId,
                  resolvedAgentProfile: resolvedAgent.profile,
                  signal: abortController.signal,
                  resolvedModel,
                  preparedTurn: reservedRecovery
                    ? {
                        userMessageId: reservedRecovery.userMessageId,
                        assistantMessageId: reservedRecovery.assistantMessageId,
                        checkpoint: reservedRecovery.checkpoint,
                      }
                    : undefined,
                  onTurnPrepared: registerTurn,
                },
                db
              )) {
                if (!clientDisconnected) {
                  controller.enqueue(sseEvent(toSsePayload(event)));
                }
              }
            } catch (err) {
              if (!abortController.signal.aborted) {
                const message = err instanceof Error ? err.message : 'Stream generation failed';
                const code = getErrorCode(err);
                const errorEvent: SSEErrorEvent = {
                  type: 'error',
                  error: message,
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
      })
  );
