import type {
  ContinuationReasonCode,
  GeneratedImagePart,
  MessagePart,
  ProviderType,
  ReasoningEffort,
} from '@mangostudio/shared';
import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import { MAX_TOOL_ITERATIONS_DEFAULT } from '@mangostudio/shared/app-settings';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { createDiagnosticLogger } from '../../../lib/logger';
import { safeJsonParse } from '../../../lib/safe-parse';
import {
  buildPersistedContextSnapshot,
  type ContextSeverity,
  type ContinuationDisplayMode,
  computeContextSnapshot,
} from '../../../services/providers/core/context-policy';
import {
  type AgentTurnExecutionState,
  type ContinuationEnvelope,
  computeSystemPromptHash,
  computeToolsetHash,
} from '../../../services/providers/core/continuation-envelope';
import {
  logContextInfo,
  logDegrade,
  logPersistenceError,
  logStateCleared,
  logStateUpdate,
  logValidContinuation,
} from '../../../services/providers/core/continuation-logger';
import {
  decideContinuation,
  decideTurnPersistence,
  getContinuationStrategy,
} from '../../../services/providers/core/continuation-runtime';
import { warmProviderForRequest } from '../../../services/providers/core/provider-readiness';
import type { AgentTurnRequest } from '../../../services/providers/types';
import { getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import {
  createGenerateImageToolPlan,
  GENERATE_IMAGE_TOOL_NAME,
  type GenerateImageToolOutcome,
  generateImagesForToolPlan,
  summarizeGenerateImageToolResult,
} from '../../../services/tools/builtin/generate-image';
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
import type { ResolvedModel } from './resolve-model';
import { resolveTurnContext } from './resolve-turn-context';
import {
  createDelegationRuntime,
  errorToToolMessage,
  executeStandardToolCallsWithProgress,
  parseToolArgs,
  stringifyToolResult,
  type ToolExecutionProgressItem,
} from './standard-tool-execution';

const TOOL_LOOP_EXHAUSTED_MESSAGE = 'The model exceeded the maximum number of tool interactions.';
const streamTextTurnLogger = createDiagnosticLogger('stream-text-turn');

export interface StreamTextTurnInput {
  chatId: string;
  userId: string;
  prompt: string;
  attachmentIds?: string[];
  model?: string;
  systemPrompt?: string;
  promptSettings?: PromptSettings;
  thinkingEnabled?: boolean;
  reasoningEffort?: ReasoningEffort;
  maxToolIterations?: number;
  contextSettings?: ContextSettings;
  toolIntent?: ToolIntent;
  agentMode?: AgentExecutionMode;
  agentId?: AgentId;
  resolvedAgentProfile?: AgentProfile;
  signal?: AbortSignal;
  resolvedModel?: ResolvedModel;
}

export type StreamEvent =
  | { type: 'user_message_id'; messageId: string }
  | { type: 'thinking_start' }
  | { type: 'thinking'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call_started'; callId: string; name: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError: boolean }
  | { type: 'subagent_started'; callId: string; agentId: string; agentName: string; task: string }
  | { type: 'subagent_text'; callId: string; agentId: string; text: string }
  | {
      type: 'subagent_tool_call_started';
      callId: string;
      agentId: string;
      toolCallId: string;
      name: string;
    }
  | {
      type: 'subagent_completed';
      callId: string;
      agentId: string;
      agentName: string;
      summary: string;
      toolCallCount: number;
    }
  | { type: 'subagent_failed'; callId: string; agentId: string; agentName?: string; error: string }
  | { type: 'image_generation_started'; imageId: string; toolCallId: string; prompt: string }
  | {
      type: 'image_generation_completed';
      imageId: string;
      toolCallId: string;
      prompt: string;
      imageUrl: string;
      modelName?: string;
      generationTime?: string;
    }
  | {
      type: 'image_generation_failed';
      imageId: string;
      toolCallId: string;
      prompt: string;
      error: string;
      modelName?: string;
      generationTime?: string;
    }
  | { type: 'fallback_notice'; from: string; to: string; reason: string }
  | { type: 'system_event'; event: string; detail: string }
  | {
      type: 'continuation_transition';
      provider: ProviderType;
      modelName: string;
      fromProvider?: ProviderType;
      fromMode: string;
      toMode: string;
      reasonCode: ContinuationReasonCode;
      detail?: string;
    }
  | {
      type: 'context_info';
      estimatedInputTokens: number;
      contextLimit: number;
      estimatedUsageRatio: number;
      mode: ContinuationDisplayMode;
      severity: ContextSeverity;
    }
  | { type: 'done'; messageId: string; generationTime: string }
  | { type: 'error'; error: string };

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

              const persistence = decideTurnPersistence(rawProviderState, provider.providerType);
              const resultEnvelope = persistence.envelope;
              executionState.durableProviderState = persistence.durableProviderState;
              executionState.turnLocalState = persistence.durableProviderState
                ? null
                : rawProviderState;

              if (resultEnvelope) {
                logStateUpdate({
                  chatId,
                  provider: resultEnvelope.provider,
                  mode: resultEnvelope.mode,
                  hasCursor: !!resultEnvelope.cursor,
                });
              }

              const displayMode = resolveDisplayMode(
                resultEnvelope,
                degradedThisTurn,
                provider.providerType
              );
              const providerReportedInputTokens =
                resultEnvelope?.context?.providerReportedInputTokens;
              const turnLocalCharCount =
                providerReportedInputTokens === undefined && displayMode !== 'stateful'
                  ? computeTurnLocalCharCount(input.prompt, rawProviderState)
                  : undefined;
              const snapshot = computeContextSnapshot({
                modelName: modelId,
                history: richHistory,
                systemPrompt: effectiveSystemPrompt,
                toolDefinitions: toolDefs,
                providerReportedTokens: providerReportedInputTokens,
                mode: displayMode,
                contextLimitOverride: resultEnvelope?.context?.contextLimit,
                turnLocalCharCount,
              });

              logContextInfo({
                chatId,
                provider: provider.providerType,
                model: modelId,
                inputTokens: snapshot.estimatedInputTokens,
                limit: snapshot.contextLimit,
                ratio: snapshot.estimatedUsageRatio,
                mode: displayMode,
              });

              const contextState = buildPersistedContextSnapshot(snapshot);
              await db
                .updateTable('chats')
                .set({
                  lastProviderState: executionState.durableProviderState,
                  lastContextState: JSON.stringify(contextState),
                })
                .where('id', '=', chatId)
                .execute()
                .catch((err) => {
                  logPersistenceError({
                    chatId,
                    error: String(err),
                    phase: 'turn_state',
                  });
                });

              yield {
                type: 'context_info',
                estimatedInputTokens: snapshot.estimatedInputTokens,
                contextLimit: snapshot.contextLimit,
                estimatedUsageRatio: snapshot.estimatedUsageRatio,
                mode: displayMode,
                severity: contextState.severity,
              };
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
            if (item.kind === 'event') {
              yield item.event;
            } else {
              const execution = item.execution;
              allParts.push({
                type: 'tool_call',
                toolCallId: execution.callId,
                name: execution.name,
                args: execution.args,
              });
              allParts.push({
                type: 'tool_result',
                toolCallId: execution.callId,
                content: execution.resultStr,
                isError: execution.isError,
              });
              if (execution.subagentTrace && multiAgentSettings.traceVisibility !== 'off') {
                allParts.push(execution.subagentTrace);
              }
              yield {
                type: 'tool_result',
                callId: execution.callId,
                name: execution.name,
                result: execution.result,
                isError: execution.isError,
              };
              nextToolResults.push({
                callId: execution.callId,
                name: execution.name,
                result: execution.resultStr,
                isError: execution.isError,
              });
            }
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
            const args = parseToolArgs(argsStr);
            let result: unknown;
            let isError = false;

            allParts.push({ type: 'tool_call', toolCallId: callId, name, args });

            try {
              const imageTool = getTool(name);
              if (!allowedToolNames.has(name)) {
                throw new Error(`Tool "${name}" is not allowed for this agent.`);
              }
              if (!imageTool) throw new Error(`Unknown tool: "${name}"`);
              const effectiveSettings = getSafeEffectiveToolSettings(
                imageTool,
                toolSettings.get(name)
              );
              if (!effectiveSettings.enabled) {
                throw new Error(`Tool "${name}" is disabled for this user.`);
              }

              const plan = createGenerateImageToolPlan(args, {
                toolCallId: callId,
                parameters: effectiveSettings.parameters,
              });
              const imagePartsById = new Map<string, GeneratedImagePart>();
              for (const imageId of plan.imageIds) {
                const part: GeneratedImagePart = {
                  type: 'generated_image',
                  imageId,
                  toolCallId: callId,
                  status: 'generating',
                  prompt: plan.prompt,
                };
                imagePartsById.set(imageId, part);
                allParts.push(part);
                yield {
                  type: 'image_generation_started',
                  imageId,
                  toolCallId: callId,
                  prompt: plan.prompt,
                };
              }

              const outcomes: GenerateImageToolOutcome[] = [];
              for await (const outcome of generateImagesForToolPlan(plan, { userId, signal })) {
                outcomes.push(outcome);
                const part = imagePartsById.get(outcome.imageId);
                if (outcome.type === 'completed') {
                  if (part) {
                    part.status = 'completed';
                    part.imageUrl = outcome.imageUrl;
                    part.modelName = outcome.modelName;
                    part.generationTime = outcome.generationTime;
                  }
                  generatedImageArtifacts.push({
                    id: outcome.imageId,
                    prompt: outcome.prompt,
                    imageUrl: outcome.imageUrl,
                    createdAt: outcome.createdAt,
                    toolCallId: callId,
                    modelName: outcome.modelName,
                    generationTime: outcome.generationTime,
                    metadata: { quality: plan.quality },
                  });
                  yield {
                    type: 'image_generation_completed',
                    imageId: outcome.imageId,
                    toolCallId: callId,
                    prompt: outcome.prompt,
                    imageUrl: outcome.imageUrl,
                    modelName: outcome.modelName,
                    generationTime: outcome.generationTime,
                  };
                } else {
                  if (part) {
                    part.status = 'error';
                    part.error = outcome.error;
                    part.modelName = outcome.modelName;
                    part.generationTime = outcome.generationTime;
                  }
                  yield {
                    type: 'image_generation_failed',
                    imageId: outcome.imageId,
                    toolCallId: callId,
                    prompt: outcome.prompt,
                    error: outcome.error,
                    modelName: outcome.modelName,
                    generationTime: outcome.generationTime,
                  };
                }
              }

              const imageResult = summarizeGenerateImageToolResult(outcomes);
              result = imageResult;
              isError = imageResult.images.length === 0 && (imageResult.errors?.length ?? 0) > 0;
            } catch (error) {
              result = { error: errorToToolMessage(error) };
              isError = true;
            }

            const resultStr = stringifyToolResult(result);
            allParts.push({ type: 'tool_result', toolCallId: callId, content: resultStr, isError });
            yield { type: 'tool_result', callId, name, result, isError };
            nextToolResults.push({ callId, name, result: resultStr, isError });
          }

          if (nonImageRunner) await nonImageRunner;
          for (const item of nonImageResultEntries) {
            if (item.kind === 'event') {
              yield item.event;
            } else {
              const execution = item.execution;
              allParts.push({
                type: 'tool_call',
                toolCallId: execution.callId,
                name: execution.name,
                args: execution.args,
              });
              allParts.push({
                type: 'tool_result',
                toolCallId: execution.callId,
                content: execution.resultStr,
                isError: execution.isError,
              });
              if (execution.subagentTrace && multiAgentSettings.traceVisibility !== 'off') {
                allParts.push(execution.subagentTrace);
              }
              yield {
                type: 'tool_result',
                callId: execution.callId,
                name: execution.name,
                result: execution.result,
                isError: execution.isError,
              };
              nextToolResults.push({
                callId: execution.callId,
                name: execution.name,
                result: execution.resultStr,
                isError: execution.isError,
              });
            }
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

/**
 * Resolves the user-facing display mode from the parsed envelope and the
 * degradation flag observed during the iteration. A cursor present means
 * server-side continuation; a stateless-loop envelope without a degradation
 * means the provider accumulated turn-local state; everything else is replay.
 */
function resolveDisplayMode(
  envelope: ContinuationEnvelope | null,
  degraded: boolean,
  providerType: ProviderType
): ContinuationDisplayMode {
  if (getContinuationStrategy(providerType).strategy === 'replay') return 'replay';
  if (envelope?.cursor) return 'stateful';
  if (envelope?.mode === 'stateless-loop' && !degraded) return 'stateless-loop';
  return 'replay';
}

/**
 * Approximate the character count of live request payload that is not yet in
 * persisted history, for use when the provider did not report token usage.
 */
function computeTurnLocalCharCount(
  prompt: string,
  providerState: string | null
): number | undefined {
  let total = prompt.length;
  const parsed = safeJsonParse(providerState);
  if (parsed && Array.isArray(parsed.loopMessages)) {
    for (const msg of parsed.loopMessages) {
      total += JSON.stringify(msg).length;
    }
  }
  return total > 0 ? total : undefined;
}

function mergeMessageParts(allParts: MessagePart[]): MessagePart[] {
  const finalParts: MessagePart[] = [];
  let thinkingRun = '';
  let textRun = '';

  const flushThinking = () => {
    if (thinkingRun) {
      finalParts.push({ type: 'thinking', text: thinkingRun });
      thinkingRun = '';
    }
  };
  const flushText = () => {
    if (textRun) {
      finalParts.push({ type: 'text', text: textRun });
      textRun = '';
    }
  };

  for (const part of allParts) {
    if (part.type === 'thinking') {
      thinkingRun += part.text;
    } else if (part.type === 'text') {
      textRun += part.text;
    } else {
      flushThinking();
      flushText();
      finalParts.push(part);
    }
  }
  flushThinking();
  flushText();

  return finalParts;
}
