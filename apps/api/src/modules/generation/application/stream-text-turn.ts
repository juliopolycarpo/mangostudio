import type { ContinuationReasonCode, MessagePart, ProviderType } from '@mangostudio/shared';
import { MAX_TOOL_ITERATIONS_DEFAULT } from '@mangostudio/shared/app-settings';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import {
  type AgentTurnExecutionState,
  computeSystemPromptHash,
  computeToolsetHash,
} from '../../../services/providers/core/continuation-envelope';
import {
  logDegrade,
  logStateCleared,
  logValidContinuation,
} from '../../../services/providers/core/continuation-logger';
import { decideContinuation } from '../../../services/providers/core/continuation-runtime';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
import type { AgentTurnRequest } from '../../../services/providers/types';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../services/tools/builtin/generate-image';
import { generateId } from '../../../utils/id';
import { resolveProviderRuntimeAttachments } from '../../attachments/application/runtime-attachment-resolver';
import { loadHistory, loadRichHistory } from '../../messages/infrastructure/message-repository';
import {
  type PersistedGeneratedImageInput,
  persistAiResponse,
  persistErrorResponse,
  persistUserMessage,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';
import { resolveTurnContext } from './resolve-turn-context';
import {
  createDelegationRuntime,
  executeStandardToolCallsWithProgress,
  type ToolExecutionProgressItem,
} from './standard-tool-execution';
import {
  collectToolExecutionResult,
  executeImageGenerationCall,
  handleTurnCompleted,
  mergeMessageParts,
} from './stream-text-turn-helpers';
import type { StreamEvent, StreamTextTurnInput } from './stream-text-turn-types';

export type { StreamEvent, StreamTextTurnInput };

const TOOL_LOOP_EXHAUSTED_MESSAGE = 'The model exceeded the maximum number of tool interactions.';
const streamTextTurnLogger = createDiagnosticLogger('stream-text-turn');

export async function* streamTextTurn(
  input: StreamTextTurnInput,
  db: Kysely<Database>
): AsyncGenerator<StreamEvent> {
  const {
    attachmentIds,
    interactionMode,
    resolvedModel,
    provider,
    agentRuntime,
    multiAgentSettings,
    toolDefinitions: toolDefs,
    allowedToolNames,
    effectiveSystemPrompt,
  } = await resolveTurnContext(input, db);
  const { modelId, capabilities } = resolvedModel;
  const runtimeSettings = agentRuntime.runtimeSettings;
  const effectivePrompt = input.prompt;
  const warmupPromise = warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: provider.generateAgentTurnStream ? 'agent-turn' : 'stream-text',
  });

  const now = Date.now();
  const userMsgId = generateId();
  await persistUserMessage(
    {
      id: userMsgId,
      userId: input.userId,
      chatId: input.chatId,
      text: input.prompt,
      attachmentIds,
      timestamp: now,
      interactionMode,
    },
    db
  );

  yield { type: 'user_message_id', messageId: userMsgId };

  const aiMsgId = generateId();
  const startTime = Date.now();
  const chatId = input.chatId;
  const userId = input.userId;
  const { signal } = input;
  const thinkingEnabled = runtimeSettings.thinkingEnabled ?? true;
  const reasoningEffort = runtimeSettings.reasoningEffort ?? 'medium';

  const allParts: MessagePart[] = [];
  const generatedImageArtifacts: PersistedGeneratedImageInput[] = [];
  const delegationState = { subagentCallCount: 0 };
  let fullText = '';
  const executionState: AgentTurnExecutionState = {
    durableProviderState: null,
    turnLocalState: null,
  };

  try {
    const runtimeAttachments = await resolveProviderRuntimeAttachments(
      {
        attachmentIds,
        userId,
        chatId,
        messageId: userMsgId,
      },
      db
    );
    await warmupPromise;

    if (provider.generateAgentTurnStream) {
      const richHistory = await loadRichHistory(chatId, { excludeId: userMsgId }, db);
      const toolSettings = agentRuntime.toolSettingsByName;

      // Cross-turn continuation state is sourced exclusively from the chat row.
      // Message-level providerState is kept only as an audit trail and must not
      // be used for continuation — doing so can resurrect stale cursors from
      // older turns that have since been superseded.
      const chatRow = await db
        .selectFrom('chats')
        .select('lastProviderState')
        .where('id', '=', chatId)
        .executeTakeFirst();
      const lastProviderState = chatRow?.lastProviderState ?? null;

      const currentSystemPromptHash = computeSystemPromptHash(effectiveSystemPrompt);
      const currentToolsetHash = computeToolsetHash(toolDefs);

      const decision = decideContinuation({
        lastProviderState,
        provider: provider.providerType,
        modelName: modelId,
        agentId: agentRuntime.profile.id,
        agentRuntimeHash: agentRuntime.runtimeHash,
        systemPromptHash: currentSystemPromptHash,
        toolsetHash: currentToolsetHash,
      });

      // rawProviderState holds the combined state for the next provider call:
      // durable cursor state (OpenAI/Gemini) or turn-local loop state
      // (Anthropic/openai-compatible).  executionState is kept separate so
      // the orchestrator persists only the durable subset across turns.
      let rawProviderState: string | null = null;

      interface DegradationContext {
        from: string;
        to: string;
        reason: string;
        reasonCode: ContinuationReasonCode;
        fromProvider?: ProviderType;
      }

      function* recordDegradation(ctx: DegradationContext): Generator<StreamEvent> {
        logDegrade({
          chatId,
          provider: provider.providerType,
          model: modelId,
          from: ctx.from,
          to: ctx.to,
          reason: ctx.reason,
          reasonCode: ctx.reasonCode,
          fromProvider: ctx.fromProvider,
        });
        const detail = `${ctx.from} → ${ctx.to}`;
        const transitionPart: Extract<MessagePart, { type: 'continuation_transition' }> = {
          type: 'continuation_transition',
          provider: provider.providerType,
          modelName: modelId,
          fromProvider: ctx.fromProvider,
          fromMode: ctx.from,
          toMode: ctx.to,
          reasonCode: ctx.reasonCode,
          detail,
          recovered: false,
        };
        allParts.push(transitionPart);
        yield { type: 'fallback_notice', from: ctx.from, to: ctx.to, reason: ctx.reason };
        yield {
          type: 'continuation_transition',
          provider: provider.providerType,
          modelName: modelId,
          fromProvider: ctx.fromProvider,
          fromMode: ctx.from,
          toMode: ctx.to,
          reasonCode: ctx.reasonCode,
          detail,
        };
      }

      switch (decision.type) {
        case 'continue_with_cursor':
          rawProviderState = decision.providerState;
          logValidContinuation({
            chatId,
            provider: provider.providerType,
            model: modelId,
            mode: decision.envelope.mode,
          });
          break;
        case 'degrade_to_replay':
          yield* recordDegradation({
            from: decision.previousMode,
            to: 'replay',
            reason: decision.reason,
            reasonCode: decision.reasonCode,
            fromProvider: decision.previousProvider,
          });
          rawProviderState = null;
          break;
        case 'start_replay':
          rawProviderState = null;
          break;
      }

      const maxIter = runtimeSettings.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT;
      const generateAgentTurnStream = provider.generateAgentTurnStream.bind(provider);
      let pendingToolResults: AgentTurnRequest['toolResults'];
      let isFirstIteration = true;
      let inThinkingSegment = false;
      let pendingCalls = new Map<string, { name: string; argsStr: string }>();

      for (let iteration = 0; iteration < maxIter; iteration++) {
        if (signal?.aborted) break;

        const req: AgentTurnRequest = {
          userId,
          modelName: modelId,
          agentId: agentRuntime.profile.id,
          agentRuntimeHash: agentRuntime.runtimeHash,
          systemPrompt: effectiveSystemPrompt,
          history: richHistory,
          prompt: isFirstIteration ? effectivePrompt : undefined,
          toolResults: pendingToolResults,
          toolDefinitions: toolDefs,
          providerState: rawProviderState,
          signal,
          attachments: isFirstIteration ? runtimeAttachments : undefined,
          modelCapabilities: capabilities,
          generationConfig: {
            thinkingEnabled,
            reasoningEffort,
            maxToolIterations: maxIter,
            maxOutputTokens: runtimeSettings.maxOutputTokens,
            promptCachePreference: runtimeSettings.promptCachePreference,
            parallelToolCallsEnabled: runtimeSettings.parallelToolCallsEnabled,
            enableProviderCompaction: runtimeSettings.providerCompactionEnabled,
            providerCompactionThreshold: input.contextSettings?.warningThreshold,
          },
        };

        pendingCalls = new Map<string, { name: string; argsStr: string }>();
        let turnCompleted = false;
        // Track whether a continuation_degraded event was received in this iteration
        // so turn_completed can derive the correct display mode.
        let degradedThisTurn = false;

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
              rawProviderState = event.providerState ?? null;
              turnCompleted = true;
              yield* handleTurnCompleted({
                db,
                providerType: provider.providerType,
                modelId,
                chatId,
                prompt: input.prompt,
                richHistory,
                effectiveSystemPrompt,
                toolDefs,
                rawProviderState,
                degradedThisTurn,
                executionState,
              });
              break;
            }

            case 'continuation_degraded':
              degradedThisTurn = true;
              yield* recordDegradation({
                from: event.from,
                to: event.to,
                reason: event.reason,
                reasonCode: event.reasonCode,
              });
              break;

            case 'turn_error':
              throw new Error(event.error);
          }
        }

        if (signal?.aborted || !turnCompleted) break;
        if (pendingCalls.size === 0) break;

        const nextToolResults: NonNullable<AgentTurnRequest['toolResults']> = [];
        const pendingCallEntries = Array.from(pendingCalls.entries());
        const hasImageGenerationCall = pendingCallEntries.some(
          ([, call]) => call.name === GENERATE_IMAGE_TOOL_NAME
        );

        if (!hasImageGenerationCall) {
          for await (const item of executeStandardToolCallsWithProgress(pendingCallEntries, {
            userId,
            chatId,
            settingsByToolName: toolSettings,
            allowedToolNames,
            delegationRuntime: createDelegationRuntime({
              db,
              userId,
              chatId,
              parentAgentProfile: agentRuntime.profile,
              parentModelName: modelId,
              interactionMode,
              settings: multiAgentSettings,
              signal,
              state: delegationState,
            }),
          })) {
            yield* collectToolExecutionResult(item, {
              allParts,
              nextToolResults,
              includeSubagentTrace: multiAgentSettings.traceVisibility !== 'off',
            });
          }
        } else {
          const nonImageEntries = pendingCallEntries.filter(
            ([, call]) => call.name !== GENERATE_IMAGE_TOOL_NAME
          );
          const imageEntries = pendingCallEntries.filter(
            ([, call]) => call.name === GENERATE_IMAGE_TOOL_NAME
          );

          const delegationRuntime = createDelegationRuntime({
            db,
            userId,
            chatId,
            parentAgentProfile: agentRuntime.profile,
            parentModelName: modelId,
            interactionMode,
            settings: multiAgentSettings,
            signal,
            state: delegationState,
          });

          const nonImageResultEntries: ToolExecutionProgressItem[] = [];
          const nonImageRunner =
            nonImageEntries.length > 0
              ? (async () => {
                  for await (const item of executeStandardToolCallsWithProgress(nonImageEntries, {
                    userId,
                    chatId,
                    settingsByToolName: toolSettings,
                    allowedToolNames,
                    delegationRuntime,
                  })) {
                    nonImageResultEntries.push(item);
                  }
                })()
              : null;

          for (const [callId, { name, argsStr }] of imageEntries) {
            yield* executeImageGenerationCall(callId, name, argsStr, {
              userId,
              signal,
              allowedToolNames,
              toolSettings,
              allParts,
              generatedImageArtifacts,
              nextToolResults,
            });
          }

          if (nonImageRunner) await nonImageRunner;
          for (const item of nonImageResultEntries) {
            yield* collectToolExecutionResult(item, {
              allParts,
              nextToolResults,
              includeSubagentTrace: multiAgentSettings.traceVisibility !== 'off',
            });
          }
        }

        pendingToolResults = nextToolResults;
        isFirstIteration = false;
      }

      if (pendingCalls.size > 0 && !signal?.aborted) {
        const detail = `Reached ${maxIter} iterations with ${pendingCalls.size} pending tool calls`;
        allParts.push({ type: 'system_event', event: 'tool_loop_exhausted', detail });
        yield { type: 'system_event', event: 'tool_loop_exhausted', detail };
        yield { type: 'error', error: TOOL_LOOP_EXHAUSTED_MESSAGE };

        if (!executionState.durableProviderState) {
          await db
            .updateTable('chats')
            .set({ lastProviderState: null })
            .where('id', '=', chatId)
            .execute()
            .catch((err) => {
              logStateCleared({
                chatId,
                reason: 'loop_exhausted',
                error: String(err),
              });
            });
        }

        const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
        const errorParts: MessagePart[] = [
          ...allParts,
          { type: 'error', text: TOOL_LOOP_EXHAUSTED_MESSAGE },
        ];
        try {
          await persistErrorResponse(
            {
              id: aiMsgId,
              userId,
              chatId,
              text: fullText || TOOL_LOOP_EXHAUSTED_MESSAGE,
              parts: errorParts,
              timestamp: Date.now(),
              generationTime,
              modelName: modelId,
              generatedImages: generatedImageArtifacts,
              interactionMode,
            },
            db
          );
          await updateChatAfterTurn(
            chatId,
            Date.now(),
            interactionMode,
            interactionMode === 'agent' ? agentRuntime.profile.id : null,
            db
          );
        } catch {
          // best-effort
        }
        return;
      }

      if (!signal?.aborted && !executionState.durableProviderState) {
        await db
          .updateTable('chats')
          .set({ lastProviderState: null })
          .where('id', '=', chatId)
          .execute()
          .catch((err) => {
            logStateCleared({
              chatId,
              reason: 'no_durable_state',
              error: String(err),
            });
          });
      }
    } else if (provider.generateTextStream) {
      const history = await loadHistory(chatId, { excludeId: userMsgId }, db);

      let legacyInThinking = false;

      for await (const chunk of provider.generateTextStream({
        userId,
        history,
        prompt: effectivePrompt,
        systemPrompt: effectiveSystemPrompt,
        modelName: modelId,
        signal,
        generationConfig: {
          thinkingEnabled,
          reasoningEffort,
          maxOutputTokens: runtimeSettings.maxOutputTokens,
          promptCachePreference: runtimeSettings.promptCachePreference,
          parallelToolCallsEnabled: runtimeSettings.parallelToolCallsEnabled,
          enableProviderCompaction: runtimeSettings.providerCompactionEnabled,
          providerCompactionThreshold: input.contextSettings?.warningThreshold,
        },
        attachments: runtimeAttachments,
        modelCapabilities: capabilities,
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
        }
      }
    } else {
      const history = await loadHistory(chatId, { excludeId: userMsgId }, db);

      const result = await provider.generateText({
        userId,
        history,
        prompt: effectivePrompt,
        systemPrompt: effectiveSystemPrompt,
        modelName: modelId,
        signal,
        generationConfig: {
          thinkingEnabled,
          reasoningEffort,
          maxOutputTokens: runtimeSettings.maxOutputTokens,
          promptCachePreference: runtimeSettings.promptCachePreference,
          parallelToolCallsEnabled: runtimeSettings.parallelToolCallsEnabled,
          enableProviderCompaction: runtimeSettings.providerCompactionEnabled,
          providerCompactionThreshold: input.contextSettings?.warningThreshold,
        },
        attachments: runtimeAttachments,
        modelCapabilities: capabilities,
      });
      if (!signal?.aborted) {
        fullText = result.text;
        yield { type: 'text', text: fullText };
      }
    }

    if (!signal?.aborted) {
      const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      const aiTimestamp = Date.now();

      // Mark all continuation_transition parts as recovered=true since the turn completed.
      for (const part of allParts) {
        if (part.type === 'continuation_transition') {
          part.recovered = true;
        }
      }

      const finalParts = mergeMessageParts(allParts);

      await persistAiResponse(
        {
          id: aiMsgId,
          userId,
          chatId,
          text: fullText,
          parts: finalParts.length > 0 ? finalParts : null,
          providerState: executionState.durableProviderState,
          timestamp: aiTimestamp,
          generationTime,
          modelName: modelId,
          generatedImages: generatedImageArtifacts,
        },
        db
      );

      await updateChatAfterTurn(
        chatId,
        aiTimestamp,
        interactionMode,
        interactionMode === 'agent' ? agentRuntime.profile.id : null,
        db
      );

      yield { type: 'done', messageId: aiMsgId, generationTime };
    }
  } catch (error: unknown) {
    if (signal?.aborted) return;

    const message = error instanceof Error ? error.message : 'Stream generation failed';
    streamTextTurnLogger.error('turn_failed', { chatId, message });

    // Clear stale durable state so a failed turn does not leave an invalid cursor
    // that would cause every subsequent turn to fail the same way.
    if (!executionState.durableProviderState) {
      await db
        .updateTable('chats')
        .set({ lastProviderState: null })
        .where('id', '=', chatId)
        .execute()
        .catch((err) => {
          logStateCleared({
            chatId,
            reason: 'turn_error',
            error: String(err),
          });
        });
    }

    try {
      const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
      const errorParts: MessagePart[] = [...allParts, { type: 'error', text: message }];
      await persistErrorResponse(
        {
          id: aiMsgId,
          userId,
          chatId,
          text: fullText || message,
          parts: errorParts,
          timestamp: Date.now(),
          generationTime,
          modelName: modelId,
          generatedImages: generatedImageArtifacts,
        },
        db
      );
    } catch {
      // best-effort
    }

    yield { type: 'error', error: message };
  }
}
