/**
 * Streaming respond route: text chat endpoint using SSE.
 * Supports the legacy text/thinking stream AND the new agentic tool loop.
 * Resolves the AI provider dynamically from the requested model.
 */

import { Elysia, t } from 'elysia';
import '../services/providers'; // ensure all providers are registered
import '../services/tools'; // ensure all builtins are registered
import { getProviderForModel } from '../services/providers/registry';
import { getUnifiedModelCatalog } from '../services/providers/catalog';
import { getDb } from '../db/database';
import { requireAuth } from '../plugins/auth-middleware';
import { generateId } from '../utils/id';
import { verifyChatOwnership } from '../services/chat-service';
import { createMessage, loadChatHistory, loadRichChatHistory } from '../services/message-service';
import { getAllToolDefinitions, executeTool } from '../services/tools';
import type { SSEErrorEvent, MessagePart, ReasoningEffort } from '@mangostudio/shared';
import type { AgentTurnRequest } from '../services/providers/types';
import {
  parseContinuationEnvelope,
  validateContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
} from '../services/providers/continuation';
import {
  computeContextSnapshot,
  getContextSeverity,
  type ContinuationDisplayMode,
} from '../services/providers/context-policy';

const MAX_TOOL_ITERATIONS = 10;
const TOOL_TIMEOUT_MS = 30_000;

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
       *
       * When the provider supports generateAgentTurnStream, the route runs the
       * full agentic tool loop (tool calling + continuation cursors).
       * Falls back to the legacy generateTextStream path otherwise.
       *
       * SSE event shapes:
       *   thinking:           { type: 'thinking', text: string, done: false }
       *   text chunk:         { type: 'text', text: string, done: false }
       *   tool call started:  { type: 'tool_call_started', callId, name, done: false }
       *   tool call done:     { type: 'tool_call_completed', callId, name, arguments, done: false }
       *   tool result:        { type: 'tool_result', callId, name, result, isError, done: false }
       *   done:               { done: true, messageId, generationTime }
       *   error:              { error: string, done: true }
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

          const aiMsgId = generateId();
          const startTime = Date.now();

          let provider;
          try {
            provider = await getProviderForModel(model, userId);
          } catch (err) {
            set.status = 400;
            return { error: err instanceof Error ? err.message : 'No provider found for model' };
          }

          // Capture context before the async boundary inside ReadableStream
          const chatId = body.chatId;
          const prompt = body.prompt;
          const systemPrompt = body.systemPrompt;

          const abortController = new AbortController();
          const { signal } = abortController;

          const thinkingEnabled = body.thinkingEnabled ?? body.thinkingVisibility !== 'off';
          const reasoningEffort = (body.reasoningEffort ?? 'medium') as ReasoningEffort;

          let continuationFallback: { from: string; to: string; reason: string } | null = null;

          const stream = new ReadableStream({
            async start(controller) {
              let fullText = '';
              let allParts: MessagePart[] = [];
              let aborted = false;
              let finalProviderState: string | null = null;

              // Emit pending fallback notice as first SSE event
              if (continuationFallback) {
                controller.enqueue(
                  sseEvent({
                    type: 'fallback_notice',
                    ...continuationFallback,
                  })
                );
                console.warn(
                  `[fallback][degrade] chatId=${chatId} from=${continuationFallback.from}` +
                    ` to=${continuationFallback.to} reason="${continuationFallback.reason}"` +
                    ` provider=${provider.providerType} model=${model}`
                );
              }

              try {
                if (provider.generateAgentTurnStream) {
                  // ── Agentic tool loop path ──────────────────────────────────
                  const richHistory = await loadRichChatHistory(
                    chatId,
                    { excludeId: userMsgId },
                    db
                  );
                  const toolDefs = getAllToolDefinitions();

                  // Discover last AI message's providerState for potential cursor reuse
                  let currentProviderState: string | null = null;
                  for (let i = richHistory.length - 1; i >= 0; i--) {
                    if (richHistory[i].role === 'ai' && richHistory[i].providerState) {
                      currentProviderState = richHistory[i].providerState!;
                      break;
                    }
                  }
                  // Fallback: check chat row (covers crash-recovery scenarios)
                  if (!currentProviderState) {
                    const chatRow = await db
                      .selectFrom('chats')
                      .select('lastProviderState')
                      .where('id', '=', chatId)
                      .executeTakeFirst();
                    if (chatRow?.lastProviderState) {
                      currentProviderState = chatRow.lastProviderState;
                    }
                  }

                  // Validate continuation envelope compatibility
                  const envelope = parseContinuationEnvelope(currentProviderState);
                  if (envelope) {
                    const currentSystemPromptHash = computeSystemPromptHash(systemPrompt);
                    const currentToolsetHash = computeToolsetHash(toolDefs);
                    const validation = validateContinuationEnvelope(envelope, {
                      provider: provider.providerType,
                      modelName: model,
                      systemPromptHash: currentSystemPromptHash,
                      toolsetHash: currentToolsetHash,
                    });
                    if (!validation.valid) {
                      console.warn(
                        `[continuation][invalid] chatId=${chatId} reason="${validation.reason}" provider=${provider.providerType} model=${model}`
                      );
                      continuationFallback = {
                        from: envelope.mode,
                        to: 'replay',
                        reason: validation.reason ?? 'unknown',
                      };
                      // Emit the fallback notice now (we're inside the stream)
                      controller.enqueue(
                        sseEvent({
                          type: 'fallback_notice',
                          ...continuationFallback,
                        })
                      );
                      console.warn(
                        `[fallback][degrade] chatId=${chatId} from=${continuationFallback.from}` +
                          ` to=${continuationFallback.to} reason="${continuationFallback.reason}"` +
                          ` provider=${provider.providerType} model=${model}`
                      );
                      currentProviderState = null; // Force full replay
                    } else {
                      console.log(
                        `[continuation][valid] chatId=${chatId} provider=${provider.providerType} model=${model} mode=${envelope.mode}`
                      );
                    }
                  }

                  let pendingToolResults: AgentTurnRequest['toolResults'];
                  let isFirstIteration = true;

                  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
                    if (signal.aborted) {
                      aborted = true;
                      break;
                    }

                    const req: AgentTurnRequest = {
                      userId,
                      modelName: model,
                      systemPrompt,
                      history: richHistory,
                      prompt: isFirstIteration ? prompt : undefined,
                      toolResults: pendingToolResults,
                      toolDefinitions: toolDefs,
                      providerState: currentProviderState,
                      signal,
                      generationConfig: { thinkingEnabled, reasoningEffort },
                    };

                    // Pending calls collected from this iteration
                    const pendingCalls = new Map<string, { name: string; argsStr: string }>();
                    let turnCompleted = false;

                    for await (const event of provider.generateAgentTurnStream!(req)) {
                      if (signal.aborted) {
                        aborted = true;
                        break;
                      }

                      switch (event.type) {
                        case 'reasoning_delta':
                          allParts.push({ type: 'thinking', text: event.text });
                          controller.enqueue(
                            sseEvent({ type: 'thinking', text: event.text, done: false })
                          );
                          break;

                        case 'tool_call_started':
                          pendingCalls.set(event.callId, {
                            name: event.name ?? '',
                            argsStr: '',
                          });
                          controller.enqueue(
                            sseEvent({
                              type: 'tool_call_started',
                              callId: event.callId,
                              name: event.name,
                              done: false,
                            })
                          );
                          break;

                        case 'tool_call_arguments_delta': {
                          const call = pendingCalls.get(event.callId);
                          if (call) call.argsStr += event.delta;
                          break;
                        }

                        case 'tool_call_completed': {
                          // Authoritative args come from this event
                          pendingCalls.set(event.callId, {
                            name: event.name,
                            argsStr: event.arguments,
                          });
                          controller.enqueue(
                            sseEvent({
                              type: 'tool_call_completed',
                              callId: event.callId,
                              name: event.name,
                              arguments: event.arguments,
                              done: false,
                            })
                          );
                          break;
                        }

                        case 'assistant_text_delta':
                          fullText += event.text;
                          allParts.push({ type: 'text', text: event.text });
                          controller.enqueue(
                            sseEvent({ type: 'text', text: event.text, done: false })
                          );
                          break;

                        case 'turn_completed': {
                          currentProviderState = event.providerState ?? null;
                          finalProviderState = currentProviderState;
                          turnCompleted = true;

                          // Persist state eagerly on the chat row (survives message save failures)
                          if (finalProviderState) {
                            await db
                              .updateTable('chats')
                              .set({ lastProviderState: finalProviderState })
                              .where('id', '=', chatId)
                              .execute()
                              .catch((err) => {
                                console.warn(
                                  `[continuation][persist] Failed to save state on chat row: ${err}`
                                );
                              });
                          }

                          const resultEnvelope = parseContinuationEnvelope(currentProviderState);
                          if (resultEnvelope) {
                            console.log(
                              `[continuation][updated] chatId=${chatId} provider=${resultEnvelope.provider} mode=${resultEnvelope.mode} cursor=${resultEnvelope.cursor ? 'present' : 'none'}`
                            );
                          }

                          // Compute context snapshot and emit SSE event
                          const displayMode: ContinuationDisplayMode = resultEnvelope?.cursor
                            ? 'stateful'
                            : 'replay';
                          const snapshot = computeContextSnapshot({
                            modelName: model,
                            history: richHistory,
                            systemPrompt,
                            toolDefinitions: toolDefs,
                            providerReportedTokens:
                              resultEnvelope?.context?.providerReportedInputTokens,
                            mode: displayMode,
                          });

                          console.log(
                            `[context][info] chatId=${chatId} provider=${provider.providerType} model=${model}` +
                              ` inputTokens=${snapshot.estimatedInputTokens} limit=${snapshot.contextLimit}` +
                              ` ratio=${snapshot.estimatedUsageRatio.toFixed(2)} mode=${displayMode}`
                          );

                          controller.enqueue(
                            sseEvent({
                              type: 'context_info',
                              estimatedInputTokens: snapshot.estimatedInputTokens,
                              contextLimit: snapshot.contextLimit,
                              estimatedUsageRatio: snapshot.estimatedUsageRatio,
                              mode: displayMode,
                              severity: getContextSeverity(snapshot.estimatedUsageRatio),
                            })
                          );

                          break;
                        }

                        case 'turn_error':
                          throw new Error(event.error);
                      }
                    }

                    if (aborted || !turnCompleted) break;
                    if (pendingCalls.size === 0) break; // no tool calls → turn is done

                    // Execute tool calls (in parallel, with timeout per call)
                    const nextToolResults: NonNullable<AgentTurnRequest['toolResults']> = [];

                    await Promise.all(
                      Array.from(pendingCalls.entries()).map(
                        async ([callId, { name, argsStr }]) => {
                          let args: Record<string, unknown> = {};
                          try {
                            args = JSON.parse(argsStr) as Record<string, unknown>;
                          } catch {
                            // Malformed args — use empty object
                          }

                          let result: unknown;
                          let isError = false;

                          try {
                            const timeoutPromise = new Promise<never>((_, reject) =>
                              setTimeout(
                                () =>
                                  reject(
                                    new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)
                                  ),
                                TOOL_TIMEOUT_MS
                              )
                            );
                            result = await Promise.race([
                              executeTool(name, args, { userId, chatId }),
                              timeoutPromise,
                            ]);
                          } catch (err) {
                            result = {
                              error: err instanceof Error ? err.message : 'Tool execution failed',
                            };
                            isError = true;
                          }

                          const resultStr = JSON.stringify(result);

                          // Accumulate tool_call + tool_result parts
                          allParts.push({ type: 'tool_call', toolCallId: callId, name, args });
                          allParts.push({
                            type: 'tool_result',
                            toolCallId: callId,
                            content: resultStr,
                            isError,
                          });

                          controller.enqueue(
                            sseEvent({
                              type: 'tool_result',
                              callId,
                              name,
                              result,
                              isError,
                              done: false,
                            })
                          );

                          nextToolResults.push({ callId, name, result: resultStr, isError });
                        }
                      )
                    );

                    pendingToolResults = nextToolResults;
                    isFirstIteration = false;
                  }
                } else if (provider.generateTextStream) {
                  // ── Legacy streaming path ───────────────────────────────────
                  const history = await loadChatHistory(chatId, { excludeId: userMsgId }, db);

                  for await (const chunk of provider.generateTextStream({
                    userId,
                    history,
                    prompt,
                    systemPrompt,
                    modelName: model,
                    signal,
                    generationConfig: { thinkingEnabled, reasoningEffort },
                  })) {
                    if (signal.aborted) {
                      aborted = true;
                      break;
                    }

                    if (chunk.type === 'thinking' && chunk.text) {
                      allParts.push({ type: 'thinking', text: chunk.text });
                      controller.enqueue(
                        sseEvent({ type: 'thinking', text: chunk.text, done: false })
                      );
                    } else if (chunk.type === 'text' && chunk.text && !chunk.done) {
                      fullText += chunk.text;
                      allParts.push({ type: 'text', text: chunk.text });
                      controller.enqueue(sseEvent({ type: 'text', text: chunk.text, done: false }));
                    } else if (!chunk.type && chunk.text && !chunk.done) {
                      // Backward compat: providers not yet migrated emit no type field
                      fullText += chunk.text;
                      controller.enqueue(sseEvent({ text: chunk.text, done: false }));
                    }
                  }
                } else {
                  // ── Fallback: single-shot non-streaming ─────────────────────
                  const history = await loadChatHistory(chatId, { excludeId: userMsgId }, db);
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

                  // Consolidate thinking chunks into a single part each
                  const thinkingText = allParts
                    .filter(
                      (p): p is Extract<MessagePart, { type: 'thinking' }> => p.type === 'thinking'
                    )
                    .map((p) => p.text)
                    .join('');

                  const nonThinkingParts = allParts.filter((p) => p.type !== 'thinking');

                  const consolidatedParts: MessagePart[] = [
                    ...(thinkingText ? [{ type: 'thinking' as const, text: thinkingText }] : []),
                    ...nonThinkingParts,
                  ];

                  // Collapse consecutive text parts into one
                  const mergedText = consolidatedParts
                    .filter((p): p is Extract<MessagePart, { type: 'text' }> => p.type === 'text')
                    .map((p) => p.text)
                    .join('');

                  const finalParts: MessagePart[] = [
                    ...(thinkingText ? [{ type: 'thinking' as const, text: thinkingText }] : []),
                    ...consolidatedParts.filter((p) => p.type !== 'thinking' && p.type !== 'text'),
                    ...(mergedText ? [{ type: 'text' as const, text: mergedText }] : []),
                  ];

                  await createMessage(
                    {
                      id: aiMsgId,
                      chatId,
                      role: 'ai',
                      text: fullText,
                      parts: finalParts.length > 0 ? JSON.stringify(finalParts) : null,
                      providerState: finalProviderState,
                      timestamp: aiTimestamp,
                      isGenerating: false,
                      generationTime,
                      modelName: model,
                      interactionMode: 'chat',
                    },
                    db
                  );

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
                  return;
                }
                const message = error instanceof Error ? error.message : 'Stream generation failed';
                console.error('[respond-stream] Error:', message);

                // Persist partial AI message with accumulated parts so it survives
                // the frontend query invalidation and the user sees thinking/tool context
                try {
                  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
                  const errorParts: MessagePart[] = [...allParts, { type: 'error', text: message }];
                  await createMessage(
                    {
                      id: aiMsgId,
                      chatId,
                      role: 'ai',
                      text: fullText || message,
                      parts: JSON.stringify(errorParts),
                      timestamp: Date.now(),
                      isGenerating: false,
                      generationTime,
                      modelName: model,
                      interactionMode: 'chat',
                    },
                    db
                  );
                } catch {
                  // Best-effort persistence; don't mask the original error
                }

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
            thinkingEnabled: t.Optional(t.Boolean()),
            reasoningEffort: t.Optional(t.String()),
            thinkingVisibility: t.Optional(t.String()), // deprecated, backward compat
          }),
        }
      )
  );
