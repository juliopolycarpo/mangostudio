/**
 * SSE streaming route: thin transport adapter over stream-text-turn.
 * Responsible for pre-flight HTTP errors, SSE framing, heartbeats, abort handling,
 * and error serialization.
 */

import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
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
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { AgentSettingsError } from '../../agents/domain/agent-profile';
import {
  assertChatAttachmentIdsAvailable,
  ChatAttachmentNotFoundError,
} from '../../attachments/infrastructure/attachment-repository';
import { verifyChatOwnership } from '../../chats/infrastructure/chat-repository';
import {
  NoModelAvailableError,
  type ResolvedModel,
  resolveModel,
} from '../application/resolve-model';
import { type StreamEvent, streamTextTurn } from '../application/stream-text-turn';
import {
  assertTextTurnHasContent,
  EmptyTextTurnError,
  normalizeTextTurnAttachmentIds,
} from '../application/text-turn-content';

const KEEPALIVE_INTERVAL_MS = 15_000;

function sseEvent(data: object): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

const KEEPALIVE_BYTES = new TextEncoder().encode(': keepalive\n\n');

interface ResolvedRequestAgent {
  readonly mode: AgentExecutionMode;
  readonly agentId: AgentId;
  readonly profile: AgentProfile;
}

async function resolveRequestAgent(input: {
  readonly db: ReturnType<typeof getDb>;
  readonly userId: string;
  readonly agentMode?: AgentExecutionMode;
  readonly agentId?: string;
}): Promise<ResolvedRequestAgent> {
  const mode = input.agentMode ?? 'chat';
  const agentId = mode === 'agent' ? (input.agentId ?? 'default') : 'chat';

  const profile = await getAgentProfile(input.db, input.userId, agentId);

  return { mode, agentId: profile.id, profile };
}

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

          // Model resolution must be pre-flight to return HTTP 503 before SSE headers flush.
          let resolvedModel: ResolvedModel;
          let resolvedAgent: ResolvedRequestAgent;
          try {
            resolvedAgent = await resolveRequestAgent({
              db,
              userId,
              agentMode: body.agentMode,
              agentId: body.agentId,
            });
            resolvedModel = await resolveModel({
              requestedModel: body.model ?? resolvedAgent.profile.model,
              userId,
              type: 'text',
            });
          } catch (err) {
            if (err instanceof AgentSettingsError && err.status === 404) {
              set.status = 404;
              return { error: 'Agent not found', code: ERROR_CODES.NOT_FOUND };
            }
            if (err instanceof NoModelAvailableError) {
              set.status = 503;
              return { error: err.message, code: ERROR_CODES.PROVIDER_ERROR };
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
                    attachmentIds,
                    model: resolvedModel.modelId,
                    systemPrompt: body.systemPrompt,
                    promptSettings: body.promptSettings,
                    thinkingEnabled: body.thinkingEnabled ?? body.thinkingVisibility !== 'off',
                    reasoningEffort: body.reasoningEffort,
                    maxToolIterations: body.maxToolIterations,
                    contextSettings: body.contextSettings,
                    toolIntent: body.toolIntent,
                    agentMode: resolvedAgent.mode,
                    agentId: resolvedAgent.agentId,
                    resolvedAgentProfile: resolvedAgent.profile,
                    signal: abortController.signal,
                    resolvedModel,
                  },
                  db
                )) {
                  if (abortController.signal.aborted) break;
                  controller.enqueue(sseEvent(toSsePayload(event)));
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
