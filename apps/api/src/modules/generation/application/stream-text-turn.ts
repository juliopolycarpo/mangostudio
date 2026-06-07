import type {
  ContinuationReasonCode,
  GeneratedImagePart,
  MessagePart,
  ProviderType,
  ReasoningEffort,
  SubagentTraceEvent,
} from '@mangostudio/shared';
import {
  DELEGATION_BACKOFF_BASE_MS,
  DELEGATION_BACKOFF_MAX_MS,
  DELEGATION_MAX_RETRIES,
  mergeSubagentTraceEvents,
} from '@mangostudio/shared';
import type { AgentExecutionMode, AgentId, AgentProfile } from '@mangostudio/shared/agents';
import { isAgentId } from '@mangostudio/shared/agents';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import {
  MAX_TOOL_ITERATIONS_DEFAULT,
  SUBAGENT_MAX_TURNS_MAX,
  SUBAGENT_MAX_TURNS_MIN,
} from '@mangostudio/shared/app-settings';
import type { ContextSettings } from '@mangostudio/shared/chat';
import type { ToolIntent } from '@mangostudio/shared/generation';
import type { PromptSettings } from '@mangostudio/shared/prompt-rules';
import type { ProviderRuntimeSettings } from '@mangostudio/shared/provider-settings';
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
import {
  getProvider,
  getProviderForModel,
} from '../../../services/providers/core/provider-registry';
import type { AgentTurnRequest } from '../../../services/providers/types';
import { executeTool, getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import {
  getBoundedOptionalInteger,
  getOptionalString,
  getRequiredString,
} from '../../../services/tools/arg-parsing';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import {
  createGenerateImageToolPlan,
  GENERATE_IMAGE_TOOL_NAME,
  type GenerateImageToolOutcome,
  generateImagesForToolPlan,
  summarizeGenerateImageToolResult,
} from '../../../services/tools/builtin/generate-image';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import { generateId } from '../../../utils/id';
import { getAgentProfile } from '../../agents/application/agent-settings-service';
import { getAppSettings } from '../../app-settings/application/app-settings-service';
import { resolveProviderRuntimeAttachments } from '../../attachments/application/runtime-attachment-resolver';
import { assertChatOwnership } from '../../chats/domain/chat-ownership';
import { loadHistory, loadRichHistory } from '../../messages/infrastructure/message-repository';
import {
  type PersistedGeneratedImageInput,
  persistAiResponse,
  persistErrorResponse,
  persistUserMessage,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';
import { resolveAgentRuntime, resolveRuntimeAgentId } from './resolve-agent-runtime';
import { type ResolvedModel, resolveModel } from './resolve-model';
import {
  getSubagentCachedEntry,
  recordSubagentResult,
  recordSubagentStatus,
  recordSubagentText,
} from './subagent-response-cache';
import {
  type DelegateToSubagentRequest,
  runSubagentTurn,
  SUBAGENT_EMPTY_TEXT_FALLBACK,
  SubagentDelegationError,
  type SubagentProgressEvent,
  type SubagentRunResult,
} from './subagent-runner';
import { assertTextTurnHasContent, normalizeTextTurnAttachmentIds } from './text-turn-content';

const TOOL_TIMEOUT_MS = 30_000;
const TOOL_LOOP_EXHAUSTED_MESSAGE = 'The model exceeded the maximum number of tool interactions.';
const streamTextTurnLogger = createDiagnosticLogger('stream-text-turn');
const delegationLogger = createDiagnosticLogger('subagent-delegation');

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
  await assertChatOwnership(input.chatId, input.userId, db);
  const attachmentIds = normalizeTextTurnAttachmentIds(input.attachmentIds);
  assertTextTurnHasContent(input.prompt, attachmentIds);

  const requestedAgentId = resolveRuntimeAgentId(input.agentMode, input.agentId);
  const resolvedAgentProfile =
    input.resolvedAgentProfile ?? (await getAgentProfile(db, input.userId, requestedAgentId));
  const resolvedModel =
    input.resolvedModel ??
    (await resolveModel({
      requestedModel: input.model ?? resolvedAgentProfile.model,
      userId: input.userId,
      type: 'text',
    }));
  const { modelId, capabilities, providerType } = resolvedModel;
  const interactionMode = input.agentMode === 'agent' ? 'agent' : 'chat';

  const provider = providerType
    ? getProvider(providerType)
    : await getProviderForModel(modelId, input.userId);
  const [agentRuntime, appSettings] = await Promise.all([
    resolveAgentRuntime({
      db,
      userId: input.userId,
      agentMode: input.agentMode,
      agentId: input.agentId,
      provider: provider.providerType,
      requestRuntimeSettings: getRequestRuntimeSettings(provider.providerType, input),
      profile: resolvedAgentProfile,
    }),
    getAppSettings(db, input.userId),
  ]);
  let effectiveSystemPrompt = agentRuntime.effectiveSystemPrompt;
  const effectivePrompt = input.prompt;
  const multiAgentSettings = appSettings.multiAgentSettings;
  const delegateToolAvailable = shouldExposeDelegateTool({
    interactionMode,
    profile: agentRuntime.profile,
    settings: multiAgentSettings,
  });
  const toolDefs = agentRuntime.toolDefinitions.filter(
    (tool) => tool.name !== DELEGATE_TO_AGENT_TOOL_NAME || delegateToolAvailable
  );
  const allowedToolNames = new Set(toolDefs.map((tool) => tool.name));
  if (
    provider.generateAgentTurnStream &&
    input.toolIntent === 'image_generation_requested' &&
    allowedToolNames.has(GENERATE_IMAGE_TOOL_NAME)
  ) {
    const hint =
      'The user explicitly clicked Create images for this turn. Use the image generation tool when appropriate.';
    effectiveSystemPrompt = effectiveSystemPrompt ? `${effectiveSystemPrompt}\n\n${hint}` : hint;
  }
  const runtimeSettings = agentRuntime.runtimeSettings;
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

interface StandardToolExecution {
  callId: string;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  resultStr: string;
  isError: boolean;
  subagentTrace?: Extract<MessagePart, { type: 'subagent_trace' }>;
}

interface DelegationRuntime {
  db: Kysely<Database>;
  userId: string;
  chatId: string;
  parentAgentProfile: AgentProfile;
  parentModelName: string;
  interactionMode: 'chat' | 'agent';
  settings: MultiAgentSettings;
  signal?: AbortSignal;
  state: { subagentCallCount: number };
  onEvent?: (event: StreamEvent) => void;
}

type ToolExecutionProgressItem =
  | { kind: 'event'; event: StreamEvent }
  | { kind: 'execution'; execution: StandardToolExecution };

async function* executeStandardToolCallsWithProgress(
  calls: ReadonlyArray<[string, { name: string; argsStr: string }]>,
  context: {
    userId: string;
    chatId: string;
    settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
    allowedToolNames: ReadonlySet<string>;
    delegationRuntime?: DelegationRuntime;
  }
): AsyncGenerator<ToolExecutionProgressItem> {
  const queue = createAsyncQueue<ToolExecutionProgressItem>();
  let remaining = calls.length;

  for (const [callId, call] of calls) {
    const runtime = context.delegationRuntime
      ? {
          ...context.delegationRuntime,
          onEvent: (event: StreamEvent) => queue.push({ kind: 'event', event }),
        }
      : undefined;
    void executeStandardToolCall(callId, call.name, call.argsStr, {
      ...context,
      delegationRuntime: runtime,
    })
      .then((execution) => queue.push({ kind: 'execution', execution }))
      .catch((error: unknown) =>
        queue.push({
          kind: 'execution',
          execution: createFailedToolExecution(callId, call.name, call.argsStr, error),
        })
      )
      .finally(() => {
        remaining -= 1;
        if (remaining === 0) queue.close();
      });
  }

  yield* queue;
}

async function executeStandardToolCall(
  callId: string,
  name: string,
  argsStr: string,
  context: {
    userId: string;
    chatId: string;
    settingsByToolName: ReadonlyMap<string, EffectiveToolSettings>;
    allowedToolNames: ReadonlySet<string>;
    delegationRuntime?: DelegationRuntime;
  }
): Promise<StandardToolExecution> {
  const args = parseToolArgs(argsStr);
  let result: unknown;
  let isError = false;
  let subagentTrace: Extract<MessagePart, { type: 'subagent_trace' }> | undefined;
  const isDelegationTool =
    name === DELEGATE_TO_AGENT_TOOL_NAME && Boolean(context.delegationRuntime);

  try {
    if (!context.allowedToolNames.has(name)) {
      throw new Error(`Tool "${name}" is not allowed for this agent.`);
    }
    const runtime = context.delegationRuntime;
    if (name === DELEGATE_TO_AGENT_TOOL_NAME && runtime) {
      const tool = getTool(name);
      if (!tool) throw new Error(`Unknown tool: "${name}"`);
      const effectiveSettings = getSafeEffectiveToolSettings(
        tool,
        context.settingsByToolName.get(name)
      );
      if (!effectiveSettings.enabled) {
        throw new Error(`Tool "${name}" is disabled for this user.`);
      }
      const request = parseDelegationRequest(args);
      result = await ensureDelegationResult(callId, request, runtime);
    } else {
      result = await withToolTimeout(
        executeTool(
          name,
          args,
          {
            userId: context.userId,
            chatId: context.chatId,
            parameters: {},
          },
          context.settingsByToolName.get(name)
        ),
        name
      );
    }
    if (isSubagentRunResult(result)) {
      subagentTrace = createSubagentTraceForTool(callId, result);
      isError = result.status !== 'completed';
    }
  } catch (error) {
    result = { error: errorToToolMessage(error) };
    isError = true;
  }

  if (isDelegationTool) {
    const entry = getSubagentCachedEntry(callId);
    const summaryLength =
      (isSubagentRunResult(result) ? result.summary.length : entry?.result?.summary.length) ?? 0;
    logDelegationWarn('tool_result_ready', {
      callId,
      agentId: isSubagentRunResult(result) ? result.agentId : (entry?.agentId ?? ''),
      isError,
      summaryLength,
      cachedPartialChars: entry?.partialText?.length ?? 0,
    });
  }
  const providerResult = isSubagentRunResult(result) ? createSubagentToolResult(result) : result;

  return {
    callId,
    name,
    args,
    result: providerResult,
    resultStr: stringifyToolResult(providerResult),
    isError,
    ...(subagentTrace ? { subagentTrace } : {}),
  };
}

async function executeDelegationToolCall(
  callId: string,
  request: DelegateToSubagentRequest,
  runtime: DelegationRuntime
): Promise<SubagentRunResult> {
  if (runtime.state.subagentCallCount >= runtime.settings.maxSubagentCalls) {
    throw new SubagentDelegationError('Maximum subagent calls per turn reached.', 'MAX_CALLS');
  }

  runtime.state.subagentCallCount += 1;
  runtime.onEvent?.({
    type: 'system_event',
    event: 'subagent_delegation_started',
    detail: `call=${callId} target=${request.agentId}`,
  });

  const result = await runSubagentTurn({
    db: runtime.db,
    userId: runtime.userId,
    chatId: runtime.chatId,
    parentAgentProfile: runtime.parentAgentProfile,
    parentModelName: runtime.parentModelName,
    parentMode: runtime.interactionMode,
    settings: runtime.settings,
    request,
    depth: 0,
    signal: runtime.signal,
    onEvent: (event) => {
      if (event.type === 'text') {
        recordSubagentText(callId, event.agentId, event.text);
      }
      if (event.type === 'completed') {
        recordSubagentStatus(callId, event.agentId, event.agentName, 'completed');
      }
      if (event.type === 'failed') {
        if (event.agentName && isAgentId(event.agentId)) {
          recordSubagentStatus(callId, event.agentId, event.agentName, 'failed');
        }
      }
      runtime.onEvent?.(toSubagentStreamEvent(callId, event));
    },
  });
  recordSubagentResult(callId, result);

  runtime.onEvent?.({
    type: 'system_event',
    event:
      result.status === 'completed'
        ? 'subagent_delegation_completed'
        : 'subagent_delegation_failed',
    detail: `call=${callId} target=${result.agentId} status=${result.status} durationMs=${result.durationMs}`,
  });

  return result;
}

function toSubagentStreamEvent(callId: string, event: SubagentProgressEvent): StreamEvent {
  switch (event.type) {
    case 'started':
      return {
        type: 'subagent_started',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        task: event.task,
      };
    case 'text':
      return { type: 'subagent_text', callId, agentId: event.agentId, text: event.text };
    case 'tool_call_started':
      return {
        type: 'subagent_tool_call_started',
        callId,
        agentId: event.agentId,
        toolCallId: event.toolCallId,
        name: event.name,
      };
    case 'completed':
      return {
        type: 'subagent_completed',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        summary: event.summary,
        toolCallCount: event.toolCallCount,
      };
    case 'failed':
      return {
        type: 'subagent_failed',
        callId,
        agentId: event.agentId,
        agentName: event.agentName,
        error: event.error,
      };
  }
}

function createDelegationRuntime(
  input: Omit<DelegationRuntime, 'onEvent'>
): DelegationRuntime | undefined {
  if (
    !shouldExposeDelegateTool({
      interactionMode: input.interactionMode,
      profile: input.parentAgentProfile,
      settings: input.settings,
    })
  ) {
    return undefined;
  }
  return input;
}

function shouldExposeDelegateTool(input: {
  readonly interactionMode: 'chat' | 'agent';
  readonly profile: AgentProfile;
  readonly settings: MultiAgentSettings;
}): boolean {
  if (!input.settings.enabled) return false;
  if (input.settings.maxDepth < 1) return false;
  if (input.settings.maxSubagentCalls < 1) return false;
  if (input.profile.subagentIds.length === 0) return false;
  if (input.interactionMode === 'chat') return input.settings.chatDelegationEnabled;
  return true;
}

function isSubagentRunResult(value: unknown): value is SubagentRunResult {
  if (typeof value !== 'object' || value === null) return false;
  const result = value as Partial<SubagentRunResult>;
  return (
    typeof result.agentId === 'string' &&
    typeof result.agentName === 'string' &&
    typeof result.summary === 'string' &&
    Boolean(result.trace) &&
    typeof result.trace === 'object'
  );
}

function createSubagentTraceForTool(
  callId: string,
  result: SubagentRunResult
): Extract<MessagePart, { type: 'subagent_trace' }> {
  return {
    type: 'subagent_trace',
    toolCallId: callId,
    agentId: result.agentId,
    agentName: result.agentName,
    status: result.status,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    ...(result.trace.lastMessage ? { lastMessage: result.trace.lastMessage } : {}),
    messages: result.trace.messages,
    tools: result.trace.tools,
    ...(result.trace.events ? { events: result.trace.events } : {}),
    ...(result.trace.error ? { error: result.trace.error } : {}),
  };
}

function createSubagentToolResult(result: SubagentRunResult): Record<string, unknown> {
  return {
    agentId: result.agentId,
    agentName: result.agentName,
    status: result.status,
    summary: result.summary,
    toolCallCount: result.toolCallCount,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error.message } : {}),
  };
}

function parseDelegationRequest(args: Record<string, unknown>): DelegateToSubagentRequest {
  const rawAgentId = getRequiredString(args.agentId, 'agentId');
  if (!isAgentId(rawAgentId)) {
    throw new SubagentDelegationError(
      `Invalid delegation target agent id "${rawAgentId}".`,
      'INVALID_AGENT_ID'
    );
  }
  const task = getRequiredString(args.task, 'task');
  const context = getOptionalString(args.context);
  const expectedOutput = getOptionalString(args.expectedOutput);
  const maxTurns = getBoundedOptionalInteger(args.maxTurns, 'maxTurns', {
    min: SUBAGENT_MAX_TURNS_MIN,
    max: SUBAGENT_MAX_TURNS_MAX,
  });

  return {
    agentId: rawAgentId,
    task,
    ...(context ? { context } : {}),
    ...(expectedOutput ? { expectedOutput } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
  };
}

async function ensureDelegationResult(
  callId: string,
  request: DelegateToSubagentRequest,
  runtime: DelegationRuntime
): Promise<SubagentRunResult> {
  const maxAttempts = 1 + DELEGATION_MAX_RETRIES;
  const events: SubagentTraceEvent[] = [];
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptRequest =
      attempt === 1 ? request : addEnforcedDelegationOutputRequirement(request);

    try {
      if (attempt > 1) {
        await sleepWithAbort(
          computeBackoffMs(attempt),
          runtime.signal,
          `call=${callId} attempt=${attempt}`
        );
      }
      events.push({
        event: 'response_attempt',
        attempt,
        detail: `call=${callId} attempt=${attempt}`,
      });
      runtime.onEvent?.({
        type: 'system_event',
        event: 'subagent_response_attempt',
        detail: `call=${callId} attempt=${attempt}`,
      });

      const result = (await withDelegationTimeout(
        executeDelegationToolCall(callId, attemptRequest, runtime),
        runtime.settings.timeoutMs,
        runtime.signal
      )) as unknown;
      if (isValidSubagentResult(result)) {
        return withSubagentTraceEvents(result, events);
      }

      const cacheEntry = getSubagentCachedEntry(callId);
      const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
      if (recovered) {
        logDelegationWarn('recovered_from_cache', {
          callId,
          agentId: request.agentId,
          attempt,
          summaryLength: recovered.summary.length,
          cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
        });
        runtime.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_recovered',
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        events.push({
          event: 'response_recovered',
          attempt,
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        return withSubagentTraceEvents(recovered, events);
      }

      lastError = 'Subagent returned an invalid or empty response.';
      logDelegationWarn('invalid_result', {
        callId,
        agentId: request.agentId,
        attempt,
        status: isSubagentRunResult(result) ? result.status : 'invalid',
        summaryLength: isSubagentRunResult(result) ? result.summary.length : 0,
        toolCallCount: isSubagentRunResult(result) ? result.toolCallCount : 0,
        scenario: classifyMissingResponseScenario(cacheEntry),
        cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
      });
    } catch (error) {
      if (error instanceof SubagentDelegationError && error.code === 'TIMEOUT') {
        const text = `Subagent timed out after ${runtime.settings.timeoutMs}ms.`;
        logDelegationWarn('timeout', {
          callId,
          agentId: request.agentId,
          attempt,
          error: text,
        });
        runtime.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_timeout',
          detail: `call=${callId} agent=${request.agentId}`,
        });
        events.push({
          event: 'response_timeout',
          attempt,
          detail: `call=${callId} agent=${request.agentId}`,
        });
        return withSubagentTraceEvents(
          createTimedOutSubagentResult(callId, request.agentId, text),
          events
        );
      }
      if (isNonRetryableDelegationError(error)) {
        throw error;
      }
      lastError = errorToToolMessage(error);
      const cacheEntry = getSubagentCachedEntry(callId);
      const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
      if (recovered) {
        logDelegationWarn('recovered_from_cache_after_error', {
          callId,
          agentId: request.agentId,
          attempt,
          summaryLength: recovered.summary.length,
          cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
        });
        runtime.onEvent?.({
          type: 'system_event',
          event: 'subagent_response_recovered',
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        events.push({
          event: 'response_recovered',
          attempt,
          detail: `call=${callId} agent=${request.agentId} attempt=${attempt}`,
        });
        return withSubagentTraceEvents(recovered, events);
      }
      logDelegationWarn('attempt_failed', {
        callId,
        agentId: request.agentId,
        attempt,
        error: lastError,
        scenario: classifyMissingResponseScenario(cacheEntry),
        cachedPartialChars: cacheEntry?.partialText?.length ?? 0,
      });
    }
  }

  const cacheEntry = getSubagentCachedEntry(callId);
  const recovered = tryRecoverFromCache(callId, request.agentId, cacheEntry);
  if (recovered) return withSubagentTraceEvents(recovered, events);

  const summary = `Subagent failed to produce a final response. ${lastError}`.trim();
  const fallback = createMissingSubagentResult(callId, request.agentId, summary);
  runtime.onEvent?.({
    type: 'system_event',
    event: 'subagent_response_fallback',
    detail: `call=${callId} agent=${request.agentId}`,
  });
  events.push({
    event: 'response_fallback',
    detail: `call=${callId} agent=${request.agentId}`,
  });
  return withSubagentTraceEvents(fallback, events);
}

function withSubagentTraceEvents(
  result: SubagentRunResult,
  events: ReadonlyArray<SubagentTraceEvent>
): SubagentRunResult {
  if (events.length === 0) return result;
  const mergedEvents = mergeSubagentTraceEvents(result.trace.events, events);
  return {
    ...result,
    trace: {
      ...result.trace,
      events: mergedEvents,
    },
  };
}

function isNonRetryableDelegationError(error: unknown): boolean {
  const code = getDelegationErrorCode(error);
  if (!code) return false;
  return [
    'ABORTED',
    'DISABLED',
    'CHAT_DISABLED',
    'MAX_CALLS',
    'MAX_DEPTH',
    'TARGET_NOT_ALLOWED',
    'INVALID_ROLE',
    'INVALID_AGENT_ID',
  ].includes(code);
}

function getDelegationErrorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const record = error as { code?: unknown; name?: unknown };
  if (typeof record.code !== 'string') return undefined;
  if (record.name !== 'SubagentDelegationError') return undefined;
  return record.code;
}

function tryRecoverFromCache(
  callId: string,
  agentId: AgentId,
  cacheEntry: ReturnType<typeof getSubagentCachedEntry>
): SubagentRunResult | undefined {
  const cachedResult = cacheEntry?.result;
  if (cachedResult && isValidSubagentResult(cachedResult)) return cachedResult;
  const partial = cacheEntry?.partialText?.trim() ?? '';
  if (!partial || partial.startsWith(SUBAGENT_EMPTY_TEXT_FALLBACK)) return undefined;
  return createRecoveredSubagentResult(callId, agentId, partial);
}

function createRecoveredSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent response recovered from cache.';
  return {
    agentId,
    agentName: agentId,
    status: 'completed',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'completed',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
    },
  };
}

function createTimedOutSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent timed out.';
  return {
    agentId,
    agentName: agentId,
    status: 'timeout',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    error: { code: 'TIMEOUT', message: text },
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'timeout',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
      error: text,
    },
  };
}

function classifyMissingResponseScenario(
  cacheEntry: ReturnType<typeof getSubagentCachedEntry>
): 'produced_not_transmitted' | 'not_produced' {
  const partial = cacheEntry?.partialText?.trim() ?? '';
  if (partial) return 'produced_not_transmitted';
  return 'not_produced';
}

function computeBackoffMs(attempt: number): number {
  const exponent = Math.max(0, attempt - 2);
  const base = Math.min(DELEGATION_BACKOFF_MAX_MS, DELEGATION_BACKOFF_BASE_MS * 2 ** exponent);
  const jitter = 0.2 * base;
  const randomized = base + (Math.random() * 2 - 1) * jitter;
  return Math.max(0, Math.round(Math.min(DELEGATION_BACKOFF_MAX_MS, randomized)));
}

async function sleepWithAbort(ms: number, signal?: AbortSignal, label?: string): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new Error('Aborted');
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      clearTimeout(timeoutId);
      reject(new Error('Aborted'));
    };
    if (label) {
      logDelegationWarn('backoff', { ms, label });
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort);
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function withDelegationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<T> {
  // Check abort before arming the timer: returning early after the setTimeout
  // is scheduled leaks the timer and leaves timeoutPromise to reject unhandled
  // once it fires.
  if (signal?.aborted) {
    return Promise.reject(new SubagentDelegationError('Subagent aborted.', 'ABORTED'));
  }
  const effective = Math.max(1_000, Math.round(timeoutMs));
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () =>
        reject(new SubagentDelegationError(`Subagent timed out after ${effective}ms.`, 'TIMEOUT')),
      effective
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

/**
 * A subagent result is "valid" for the parent agent when it has a usable summary.
 *
 * The synthesized tool-summary fallback (which starts with SUBAGENT_EMPTY_TEXT_FALLBACK)
 * is intentionally accepted here: the subagent-runner now performs an explicit
 * summarize follow-up turn before falling back, so by the time we reach this
 * point with the fallback prefix the underlying model already declined to
 * summarize. Retrying the entire delegation from scratch in that case is
 * non-deterministic and wastes tokens — the fallback (with the list of tools
 * actually executed) is the most useful response available.
 *
 * Only truly malformed results (wrong shape, empty summary, or no assistant
 * message) trigger the retry path, which is reserved for genuine runner
 * failures (exceptions, malformed mocks, etc).
 */
function isValidSubagentResult(result: unknown): result is SubagentRunResult {
  if (!isSubagentRunResult(result)) return false;
  if (!result.summary.trim()) return false;
  const last = result.trace.lastMessage?.trim() ?? '';
  if (!last) return false;
  const messagesValue = (result.trace as unknown as { messages?: unknown }).messages;
  if (!Array.isArray(messagesValue)) return false;
  for (const message of messagesValue) {
    if (isSubagentTraceMessage(message) && message.role === 'assistant' && message.text.trim()) {
      return true;
    }
  }
  return false;
}

function addEnforcedDelegationOutputRequirement(
  request: DelegateToSubagentRequest
): DelegateToSubagentRequest {
  const suffix =
    'Always end with a non-empty, plain-text summary. If you used tools, summarize the outcomes.';
  const expectedOutput = request.expectedOutput?.trim();
  if (!expectedOutput) return { ...request, expectedOutput: suffix };
  if (expectedOutput.includes(suffix)) return request;
  return { ...request, expectedOutput: `${expectedOutput}\n\n${suffix}` };
}

function createMissingSubagentResult(
  callId: string,
  agentId: AgentId,
  summary: string
): SubagentRunResult {
  const text = summary.trim() || 'Subagent response missing.';
  return {
    agentId,
    agentName: agentId,
    status: 'failed',
    summary: text,
    messages: [{ role: 'assistant', text }],
    toolCallCount: 0,
    tools: [],
    durationMs: 0,
    error: { code: 'FAILED', message: text },
    trace: {
      type: 'subagent_trace',
      toolCallId: callId,
      agentId,
      agentName: agentId,
      status: 'failed',
      summary: text,
      toolCallCount: 0,
      lastMessage: text,
      messages: [{ role: 'assistant', text }],
      tools: [],
      error: text,
    },
  };
}

type LogValue = string | number | boolean;
type LogMetadata = Record<string, LogValue>;

function logDelegationWarn(event: string, metadata: LogMetadata): void {
  delegationLogger.warn(event, metadata);
}

function isSubagentTraceMessage(
  value: unknown
): value is { role: 'assistant' | 'system'; text: string } {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    (record.role === 'assistant' || record.role === 'system') && typeof record.text === 'string'
  );
}

function createFailedToolExecution(
  callId: string,
  name: string,
  argsStr: string,
  error: unknown
): StandardToolExecution {
  const result = { error: errorToToolMessage(error) };
  return {
    callId,
    name,
    args: parseToolArgs(argsStr),
    result,
    resultStr: stringifyToolResult(result),
    isError: true,
  };
}

function createAsyncQueue<T>(): AsyncIterable<T> & {
  push: (item: T) => void;
  close: () => void;
} {
  const items: T[] = [];
  const waiters: Array<(result: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
        return;
      }
      items.push(item);
    },
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const item = items.shift();
          if (item !== undefined) return Promise.resolve({ value: item, done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };
}

function parseToolArgs(argsStr: string): Record<string, unknown> {
  return safeJsonParse(argsStr) ?? {};
}

function withToolTimeout<T>(promise: Promise<T>, name: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Tool "${name}" timed out after ${TOOL_TIMEOUT_MS}ms`)),
      TOOL_TIMEOUT_MS
    );
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

function stringifyToolResult(result: unknown): string {
  try {
    const serialized = JSON.stringify(result);
    return typeof serialized === 'string' ? serialized : 'null';
  } catch {
    return JSON.stringify({ error: 'Tool result serialization failed.' });
  }
}

function errorToToolMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed';
}

function getRequestRuntimeSettings(
  provider: ProviderType,
  input: StreamTextTurnInput
): Partial<ProviderRuntimeSettings> {
  return {
    provider,
    ...(input.thinkingEnabled !== undefined ? { thinkingEnabled: input.thinkingEnabled } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    ...(input.maxToolIterations !== undefined
      ? { maxToolIterations: input.maxToolIterations }
      : {}),
    ...(input.contextSettings?.providerCompactionEnabled !== undefined
      ? { providerCompactionEnabled: input.contextSettings.providerCompactionEnabled }
      : {}),
  };
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
