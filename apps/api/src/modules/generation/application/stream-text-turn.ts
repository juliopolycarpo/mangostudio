import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import type { MessagePart, ReasoningEffort } from '@mangostudio/shared';
import type { AgentTurnRequest } from '../../../services/providers/types';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { resolveModel } from './resolve-model';
import { loadHistory, loadRichHistory } from '../../messages/infrastructure/message-repository';
import { getProviderForModel } from '../../../services/providers/registry';
import { getAllToolDefinitions, executeTool } from '../../../services/tools';
import { generateId } from '../../../utils/id';
import {
  persistUserMessage,
  persistAiResponse,
  persistErrorResponse,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';
import {
  parseContinuationEnvelope,
  validateContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
  isDurableMode,
} from '../../../services/providers/continuation';
import {
  computeContextSnapshot,
  getContextSeverity,
  type ContinuationDisplayMode,
} from '../../../services/providers/context-policy';

const MAX_TOOL_ITERATIONS = 10;
const TOOL_TIMEOUT_MS = 30_000;

export interface StreamTextTurnInput {
  chatId: string;
  userId: string;
  prompt: string;
  model?: string;
  systemPrompt?: string;
  thinkingEnabled?: boolean;
  reasoningEffort?: string;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'user_message_id'; messageId: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call_started'; callId: string; name: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError: boolean }
  | { type: 'fallback_notice'; from: string; to: string; reason: string }
  | { type: 'system_event'; event: string; detail: string }
  | {
      type: 'context_info';
      estimatedInputTokens: number;
      contextLimit: number;
      estimatedUsageRatio: number;
      mode: ContinuationDisplayMode;
      severity: ReturnType<typeof getContextSeverity>;
    }
  | { type: 'done'; messageId: string; generationTime: string }
  | { type: 'error'; error: string };

export async function* streamTextTurn(
  input: StreamTextTurnInput,
  db: Kysely<Database>
): AsyncGenerator<StreamEvent> {
  await assertChatOwnership(input.chatId, input.userId, db);

  const { modelId } = await resolveModel({
    requestedModel: input.model,
    userId: input.userId,
    type: 'text',
  });

  const provider = await getProviderForModel(modelId, input.userId);

  const now = Date.now();
  const userMsgId = generateId();
  await persistUserMessage(
    { id: userMsgId, chatId: input.chatId, text: input.prompt, timestamp: now },
    db
  );

  yield { type: 'user_message_id', messageId: userMsgId };

  const aiMsgId = generateId();
  const startTime = Date.now();
  const chatId = input.chatId;
  const userId = input.userId;
  const { systemPrompt, signal } = input;
  const thinkingEnabled = input.thinkingEnabled ?? true;
  const reasoningEffort = (input.reasoningEffort ?? 'medium') as ReasoningEffort;

  const allParts: MessagePart[] = [];
  let fullText = '';
  let durableProviderState: string | null = null;

  try {
    if (provider.generateAgentTurnStream) {
      const richHistory = await loadRichHistory(chatId, { excludeId: userMsgId }, db);
      const toolDefs = getAllToolDefinitions();

      let currentProviderState: string | null = null;
      for (let i = richHistory.length - 1; i >= 0; i--) {
        const ps = richHistory[i].providerState;
        if (richHistory[i].role === 'ai' && ps) {
          currentProviderState = ps;
          break;
        }
      }

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

      const envelope = parseContinuationEnvelope(currentProviderState);
      if (envelope) {
        const currentSystemPromptHash = computeSystemPromptHash(systemPrompt);
        const currentToolsetHash = computeToolsetHash(toolDefs);
        const validation = validateContinuationEnvelope(envelope, {
          provider: provider.providerType,
          modelName: modelId,
          systemPromptHash: currentSystemPromptHash,
          toolsetHash: currentToolsetHash,
        });

        if (!validation.valid) {
          console.warn(
            `[continuation][invalid] chatId=${chatId} reason="${validation.reason}" provider=${provider.providerType} model=${modelId}`
          );
          const fallback = {
            from: envelope.mode,
            to: 'replay',
            reason: validation.reason ?? 'unknown',
          };
          yield { type: 'fallback_notice', ...fallback };
          console.warn(
            `[fallback][degrade] chatId=${chatId} from=${fallback.from} to=${fallback.to} reason="${fallback.reason}" provider=${provider.providerType} model=${modelId}`
          );
          allParts.push({
            type: 'system_event',
            event: 'cursor_lost',
            detail: `${fallback.from} → ${fallback.to}`,
          });
          yield {
            type: 'system_event',
            event: 'cursor_lost',
            detail: `${fallback.from} → ${fallback.to}`,
          };
          currentProviderState = null;
        } else {
          console.warn(
            `[continuation][valid] chatId=${chatId} provider=${provider.providerType} model=${modelId} mode=${envelope.mode}`
          );
        }
      }

      const generateAgentTurnStream = provider.generateAgentTurnStream.bind(provider);
      let pendingToolResults: AgentTurnRequest['toolResults'];
      let isFirstIteration = true;
      let inThinkingSegment = false;

      for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
        if (signal?.aborted) break;

        const req: AgentTurnRequest = {
          userId,
          modelName: modelId,
          systemPrompt,
          history: richHistory,
          prompt: isFirstIteration ? input.prompt : undefined,
          toolResults: pendingToolResults,
          toolDefinitions: toolDefs,
          providerState: currentProviderState,
          signal,
          generationConfig: { thinkingEnabled, reasoningEffort },
        };

        const pendingCalls = new Map<string, { name: string; argsStr: string }>();
        let turnCompleted = false;

        for await (const event of generateAgentTurnStream(req)) {
          if (signal?.aborted) break;

          switch (event.type) {
            case 'reasoning_delta':
              if (!inThinkingSegment) {
                inThinkingSegment = true;
                yield { type: 'thinking_start' };
              }
              allParts.push({ type: 'thinking', text: event.text });
              yield { type: 'thinking', text: event.text };
              break;

            case 'tool_call_started':
              inThinkingSegment = false;
              pendingCalls.set(event.callId, { name: event.name ?? '', argsStr: '' });
              yield { type: 'tool_call_started', callId: event.callId, name: event.name ?? '' };
              break;

            case 'tool_call_arguments_delta': {
              const call = pendingCalls.get(event.callId);
              if (call) call.argsStr += event.delta;
              break;
            }

            case 'tool_call_completed': {
              pendingCalls.set(event.callId, { name: event.name, argsStr: event.arguments });
              yield {
                type: 'tool_call_completed',
                callId: event.callId,
                name: event.name,
                arguments: event.arguments,
              };
              break;
            }

            case 'assistant_text_delta':
              inThinkingSegment = false;
              fullText += event.text;
              allParts.push({ type: 'text', text: event.text });
              yield { type: 'text', text: event.text };
              break;

            case 'turn_completed': {
              inThinkingSegment = false;
              currentProviderState = event.providerState ?? null;
              turnCompleted = true;

              const resultEnvelope = parseContinuationEnvelope(currentProviderState);
              durableProviderState =
                resultEnvelope && isDurableMode(resultEnvelope.mode) ? currentProviderState : null;

              if (durableProviderState) {
                await db
                  .updateTable('chats')
                  .set({ lastProviderState: durableProviderState })
                  .where('id', '=', chatId)
                  .execute()
                  .catch((err) => {
                    console.warn(
                      `[continuation][persist] Failed to save state on chat row: ${err}`
                    );
                  });
              }

              if (resultEnvelope) {
                console.warn(
                  `[continuation][updated] chatId=${chatId} provider=${resultEnvelope.provider} mode=${resultEnvelope.mode} cursor=${resultEnvelope.cursor ? 'present' : 'none'}`
                );
              }

              const displayMode: ContinuationDisplayMode = resultEnvelope?.cursor
                ? 'stateful'
                : 'replay';
              const snapshot = computeContextSnapshot({
                modelName: modelId,
                history: richHistory,
                systemPrompt,
                toolDefinitions: toolDefs,
                providerReportedTokens: resultEnvelope?.context?.providerReportedInputTokens,
                mode: displayMode,
                contextLimitOverride: resultEnvelope?.context?.contextLimit,
              });

              console.warn(
                `[context][info] chatId=${chatId} provider=${provider.providerType} model=${modelId}` +
                  ` inputTokens=${snapshot.estimatedInputTokens} limit=${snapshot.contextLimit}` +
                  ` ratio=${snapshot.estimatedUsageRatio.toFixed(2)} mode=${displayMode}`
              );

              yield {
                type: 'context_info',
                estimatedInputTokens: snapshot.estimatedInputTokens,
                contextLimit: snapshot.contextLimit,
                estimatedUsageRatio: snapshot.estimatedUsageRatio,
                mode: displayMode,
                severity: getContextSeverity(snapshot.estimatedUsageRatio),
              };
              break;
            }

            case 'continuation_degraded':
              yield {
                type: 'fallback_notice',
                from: event.from,
                to: event.to,
                reason: event.reason,
              };
              console.warn(
                `[fallback][degrade] chatId=${chatId} from=${event.from} to=${event.to} reason="${event.reason}" provider=${provider.providerType} model=${modelId}`
              );
              allParts.push({
                type: 'system_event',
                event: 'cursor_lost',
                detail: `${event.from} → ${event.to}`,
              });
              yield {
                type: 'system_event',
                event: 'cursor_lost',
                detail: `${event.from} → ${event.to}`,
              };
              break;

            case 'turn_error':
              throw new Error(event.error);
          }
        }

        if (signal?.aborted || !turnCompleted) break;
        if (pendingCalls.size === 0) break;

        const nextToolResults: NonNullable<AgentTurnRequest['toolResults']> = [];

        const toolExecutions = await Promise.all(
          Array.from(pendingCalls.entries()).map(async ([callId, { name, argsStr }]) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(argsStr) as Record<string, unknown>;
            } catch {
              // malformed args — use empty object
            }

            let result: unknown;
            let isError = false;

            try {
              const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
                  TOOL_TIMEOUT_MS
                )
              );
              result = await Promise.race([
                executeTool(name, args, { userId, chatId }),
                timeoutPromise,
              ]);
            } catch (err) {
              result = { error: err instanceof Error ? err.message : 'Tool execution failed' };
              isError = true;
            }

            const resultStr = JSON.stringify(result);
            return { callId, name, args, result, resultStr, isError };
          })
        );

        for (const { callId, name, args, result, resultStr, isError } of toolExecutions) {
          allParts.push({ type: 'tool_call', toolCallId: callId, name, args });
          allParts.push({ type: 'tool_result', toolCallId: callId, content: resultStr, isError });
          yield { type: 'tool_result', callId, name, result, isError } as StreamEvent;
          nextToolResults.push({ callId, name, result: resultStr, isError });
        }

        pendingToolResults = nextToolResults;
        isFirstIteration = false;
      }

      if (!signal?.aborted && !durableProviderState) {
        await db
          .updateTable('chats')
          .set({ lastProviderState: null })
          .where('id', '=', chatId)
          .execute()
          .catch((err) => {
            console.warn(`[continuation][clear] Failed to clear stale state: ${err}`);
          });
      }
    } else if (provider.generateTextStream) {
      const history = await loadHistory(chatId, { excludeId: userMsgId }, db);
      let legacyInThinking = false;

      for await (const chunk of provider.generateTextStream({
        userId,
        history,
        prompt: input.prompt,
        systemPrompt,
        modelName: modelId,
        signal,
        generationConfig: { thinkingEnabled, reasoningEffort },
      })) {
        if (signal?.aborted) break;

        if (chunk.type === 'thinking' && chunk.text) {
          if (!legacyInThinking) {
            legacyInThinking = true;
            yield { type: 'thinking_start' };
          }
          allParts.push({ type: 'thinking', text: chunk.text });
          yield { type: 'thinking', text: chunk.text };
        } else if (chunk.type === 'text' && chunk.text && !chunk.done) {
          legacyInThinking = false;
          fullText += chunk.text;
          allParts.push({ type: 'text', text: chunk.text });
          yield { type: 'text', text: chunk.text };
        } else if (!chunk.type && chunk.text && !chunk.done) {
          legacyInThinking = false;
          fullText += chunk.text;
          yield { type: 'text', text: chunk.text };
        }
      }
    } else {
      const history = await loadHistory(chatId, { excludeId: userMsgId }, db);
      const result = await provider.generateText({
        userId,
        history,
        prompt: input.prompt,
        systemPrompt,
        modelName: modelId,
        signal,
      });
      if (!signal?.aborted) {
        fullText = result.text;
        yield { type: 'text', text: fullText };
      }
    }

    if (!signal?.aborted) {
      const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      const aiTimestamp = Date.now();

      const finalParts = mergeMessageParts(allParts);

      await persistAiResponse(
        {
          id: aiMsgId,
          chatId,
          text: fullText,
          parts: finalParts.length > 0 ? finalParts : null,
          providerState: durableProviderState,
          timestamp: aiTimestamp,
          generationTime,
          modelName: modelId,
        },
        db
      );

      await updateChatAfterTurn(chatId, aiTimestamp, db);

      yield { type: 'done', messageId: aiMsgId, generationTime };
    }
  } catch (error: unknown) {
    if (signal?.aborted) return;

    const message = error instanceof Error ? error.message : 'Stream generation failed';
    console.error('[stream-text-turn] Error:', message);

    try {
      const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      const errorParts: MessagePart[] = [...allParts, { type: 'error', text: message }];
      await persistErrorResponse(
        {
          id: aiMsgId,
          chatId,
          text: fullText || message,
          parts: errorParts,
          timestamp: Date.now(),
          generationTime,
          modelName: modelId,
        },
        db
      );
    } catch {
      // best-effort
    }

    yield { type: 'error', error: message };
  }
}

function mergeMessageParts(allParts: MessagePart[]): MessagePart[] {
  // Merge consecutive thinking chunks into segments, preserving interleaved order
  const orderedSegments: MessagePart[] = [];
  let currentThinkingSegment = '';

  for (const part of allParts) {
    if (part.type === 'thinking') {
      currentThinkingSegment += part.text;
    } else {
      if (currentThinkingSegment) {
        orderedSegments.push({ type: 'thinking', text: currentThinkingSegment });
        currentThinkingSegment = '';
      }
      orderedSegments.push(part);
    }
  }
  if (currentThinkingSegment) {
    orderedSegments.push({ type: 'thinking', text: currentThinkingSegment });
  }

  // Collapse consecutive text parts
  const finalParts: MessagePart[] = [];
  let currentTextRun = '';

  for (const part of orderedSegments) {
    if (part.type === 'text') {
      currentTextRun += part.text;
    } else {
      if (currentTextRun) {
        finalParts.push({ type: 'text', text: currentTextRun });
        currentTextRun = '';
      }
      finalParts.push(part);
    }
  }
  if (currentTextRun) {
    finalParts.push({ type: 'text', text: currentTextRun });
  }

  return finalParts;
}
