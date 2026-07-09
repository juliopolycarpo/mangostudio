import type { GeneratedImagePart, MessagePart, ProviderType } from '@mangostudio/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { safeJsonParse } from '../../../lib/safe-parse';
import {
  buildPersistedContextSnapshot,
  type ContinuationDisplayMode,
  computeContextSnapshot,
} from '../../../services/providers/core/context-policy';
import type {
  AgentTurnExecutionState,
  ContinuationEnvelope,
} from '../../../services/providers/core/continuation-envelope';
import {
  logContextInfo,
  logPersistenceError,
  logStateUpdate,
} from '../../../services/providers/core/continuation-logger';
import {
  decideTurnPersistence,
  getContinuationStrategy,
} from '../../../services/providers/core/continuation-runtime';
import { recordProviderTurn } from '../../../services/providers/core/provider-observability';
import type {
  AgentTurnRequest,
  ChatTurnContext,
  ToolDefinition,
} from '../../../services/providers/types';
import { getSafeEffectiveToolSettings, getTool } from '../../../services/tools';
import {
  createGenerateImageToolPlan,
  type GenerateImageToolOutcome,
  generateImagesForToolPlan,
  summarizeGenerateImageToolResult,
} from '../../../services/tools/builtin/generate-image';
import type { EffectiveToolSettings } from '../../../services/tools/types';
import type { PersistedGeneratedImageInput } from '../infrastructure/conversation-persistence';
import type { ToolExecutionProgressItem } from './standard-tool-execution';
import type { StreamEvent } from './stream-text-turn-types';
import { errorToToolMessage, parseToolArgs, stringifyToolResult } from './tool-result-utils';

/** Accumulators a completed tool execution writes into for the turn. */
interface ToolResultSink {
  allParts: MessagePart[];
  nextToolResults: NonNullable<AgentTurnRequest['toolResults']>;
  includeSubagentTrace: boolean;
}

/**
 * Translate one tool-execution progress item into stream output: subagent
 * progress events pass through, while a completed execution appends its
 * tool_call/tool_result parts (and any subagent trace) and queues the result
 * for the next provider turn.
 *
 * // Usage: yield* collectToolExecutionResult(item, sink);
 */
export function* collectToolExecutionResult(
  item: ToolExecutionProgressItem,
  sink: ToolResultSink
): Generator<StreamEvent> {
  if (item.kind === 'event') {
    yield item.event;
    return;
  }
  const execution = item.execution;
  sink.allParts.push({
    type: 'tool_call',
    toolCallId: execution.callId,
    name: execution.name,
    args: execution.args,
  });
  sink.allParts.push({
    type: 'tool_result',
    toolCallId: execution.callId,
    content: execution.resultStr,
    isError: execution.isError,
  });
  if (execution.subagentTrace && sink.includeSubagentTrace) {
    sink.allParts.push(execution.subagentTrace);
  }
  for (const mediaPart of execution.mcpMedia ?? []) {
    sink.allParts.push(mediaPart);
    yield { type: 'mcp_media', part: mediaPart };
  }
  if (execution.questionPart) {
    sink.allParts.push(execution.questionPart);
    yield { type: 'question', part: execution.questionPart };
  }
  if (execution.todoPart) {
    sink.allParts.push(execution.todoPart);
    yield { type: 'todo_update', part: execution.todoPart };
  }
  yield {
    type: 'tool_result',
    callId: execution.callId,
    name: execution.name,
    result: execution.result,
    isError: execution.isError,
  };
  sink.nextToolResults.push({
    callId: execution.callId,
    name: execution.name,
    result: execution.resultStr,
    isError: execution.isError,
  });
}

/** Context an image-generation tool call needs beyond its own identifiers. */
interface ImageGenerationCallContext {
  userId: string;
  signal?: AbortSignal;
  allowedToolNames: ReadonlySet<string>;
  toolSettings: ReadonlyMap<string, EffectiveToolSettings>;
  allParts: MessagePart[];
  generatedImageArtifacts: PersistedGeneratedImageInput[];
  nextToolResults: NonNullable<AgentTurnRequest['toolResults']>;
}

/**
 * Run a single generate_image tool call, streaming per-image lifecycle events
 * and recording the resulting message parts, persisted artifacts, and tool
 * result for the turn.
 *
 * // Usage: yield* executeImageGenerationCall(callId, name, argsStr, ctx);
 */
export async function* executeImageGenerationCall(
  callId: string,
  name: string,
  argsStr: string,
  ctx: ImageGenerationCallContext
): AsyncGenerator<StreamEvent> {
  const args = parseToolArgs(argsStr);
  let result: unknown;
  let isError = false;

  ctx.allParts.push({ type: 'tool_call', toolCallId: callId, name, args });

  try {
    const imageTool = getTool(name);
    if (!ctx.allowedToolNames.has(name)) {
      throw new Error(`Tool "${name}" is not allowed for this agent.`);
    }
    if (!imageTool) throw new Error(`Unknown tool: "${name}"`);
    const effectiveSettings = getSafeEffectiveToolSettings(imageTool, ctx.toolSettings.get(name));
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
      ctx.allParts.push(part);
      yield { type: 'image_generation_started', imageId, toolCallId: callId, prompt: plan.prompt };
    }

    const outcomes: GenerateImageToolOutcome[] = [];
    for await (const outcome of generateImagesForToolPlan(plan, {
      userId: ctx.userId,
      signal: ctx.signal,
    })) {
      outcomes.push(outcome);
      const part = imagePartsById.get(outcome.imageId);
      if (outcome.type === 'completed') {
        if (part) {
          part.status = 'completed';
          part.imageUrl = outcome.imageUrl;
          part.modelName = outcome.modelName;
          part.generationTime = outcome.generationTime;
        }
        ctx.generatedImageArtifacts.push({
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
  ctx.allParts.push({ type: 'tool_result', toolCallId: callId, content: resultStr, isError });
  yield { type: 'tool_result', callId, name, result, isError };
  ctx.nextToolResults.push({ callId, name, result: resultStr, isError });
}

/** Inputs the turn_completed handler needs to persist state and report context. */
interface TurnCompletedContext {
  db: Kysely<Database>;
  providerType: ProviderType;
  modelId: string;
  chatId: string;
  prompt: string;
  richHistory: ChatTurnContext[];
  effectiveSystemPrompt: string | undefined;
  toolDefs: ToolDefinition[];
  rawProviderState: string | null;
  degradedThisTurn: boolean;
  executionState: AgentTurnExecutionState;
}

/**
 * Persist the durable provider state for a completed model turn and emit the
 * context_info event describing token usage and the resolved display mode.
 *
 * // Usage: yield* handleTurnCompleted(turnCtx);
 */
export async function* handleTurnCompleted(ctx: TurnCompletedContext): AsyncGenerator<StreamEvent> {
  const persistence = decideTurnPersistence(ctx.rawProviderState, ctx.providerType);
  const resultEnvelope = persistence.envelope;
  ctx.executionState.durableProviderState = persistence.durableProviderState;
  ctx.executionState.turnLocalState = persistence.durableProviderState
    ? null
    : ctx.rawProviderState;

  if (resultEnvelope) {
    logStateUpdate({
      chatId: ctx.chatId,
      provider: resultEnvelope.provider,
      mode: resultEnvelope.mode,
      hasCursor: !!resultEnvelope.cursor,
    });
  }

  const displayMode = resolveDisplayMode(resultEnvelope, ctx.degradedThisTurn, ctx.providerType);
  const providerReportedInputTokens = resultEnvelope?.context?.providerReportedInputTokens;
  const turnLocalCharCount =
    providerReportedInputTokens === undefined && displayMode !== 'stateful'
      ? computeTurnLocalCharCount(ctx.prompt, ctx.rawProviderState)
      : undefined;
  const snapshot = computeContextSnapshot({
    modelName: ctx.modelId,
    history: ctx.richHistory,
    systemPrompt: ctx.effectiveSystemPrompt,
    toolDefinitions: ctx.toolDefs,
    providerReportedTokens: providerReportedInputTokens,
    mode: displayMode,
    contextLimitOverride: resultEnvelope?.context?.contextLimit,
    turnLocalCharCount,
  });

  logContextInfo({
    chatId: ctx.chatId,
    provider: ctx.providerType,
    model: ctx.modelId,
    inputTokens: snapshot.estimatedInputTokens,
    limit: snapshot.contextLimit,
    ratio: snapshot.estimatedUsageRatio,
    mode: displayMode,
  });

  recordProviderTurn({
    provider: ctx.providerType,
    kind: 'text',
    inputTokens: snapshot.estimatedInputTokens,
  });

  const contextState = buildPersistedContextSnapshot(snapshot);
  await ctx.db
    .updateTable('chats')
    .set({
      lastProviderState: ctx.executionState.durableProviderState,
      lastContextState: JSON.stringify(contextState),
    })
    .where('id', '=', ctx.chatId)
    .execute()
    .catch((err) => {
      logPersistenceError({ chatId: ctx.chatId, error: String(err), phase: 'turn_state' });
    });

  yield {
    type: 'context_info',
    estimatedInputTokens: snapshot.estimatedInputTokens,
    contextLimit: snapshot.contextLimit,
    estimatedUsageRatio: snapshot.estimatedUsageRatio,
    mode: displayMode,
    severity: contextState.severity,
  };
}

/**
 * Resolve the user-facing display mode from the parsed envelope and the
 * degradation flag observed during the iteration. A cursor present means
 * server-side continuation; a stateless-loop envelope without a degradation
 * means the provider accumulated turn-local state; everything else is replay.
 *
 * // Usage: const mode = resolveDisplayMode(envelope, degraded, 'openai');
 */
export function resolveDisplayMode(
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
 *
 * // Usage: const chars = computeTurnLocalCharCount(prompt, providerState);
 */
export function computeTurnLocalCharCount(
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

/**
 * Coalesce consecutive thinking/text parts into single runs so the persisted
 * message stores one part per contiguous segment instead of per delta.
 *
 * // Usage: const parts = mergeMessageParts(allParts);
 */
export function mergeMessageParts(allParts: MessagePart[]): MessagePart[] {
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
