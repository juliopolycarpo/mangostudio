import type { GeneratedImagePart, MessagePart, ProviderType } from '@mangostudio/shared';
import {
  applyToolExecutionTransition,
  isTerminalToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
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
import {
  classifyToolExecutionFailure,
  ToolExecutionLifecycle,
  type ToolExecutionTransitionEvent,
  ToolPolicyError,
} from './tool-execution-lifecycle';
import { errorToToolMessage, parseToolArgs, stringifyToolResult } from './tool-result-utils';
import { IMAGE_ABANDONED_ERROR } from './turn-recovery';

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
    const event = item.event;
    if (
      event.type === 'mcp_elicitation' &&
      !sink.allParts.some(
        (part) => part.type === 'mcp_elicitation' && part.elicitationId === event.part.elicitationId
      )
    ) {
      sink.allParts.push(event.part);
    }
    yield event;
    return;
  }
  const execution = item.execution;
  upsertToolCallPart(sink.allParts, {
    type: 'tool_call',
    toolCallId: execution.callId,
    name: execution.name,
    args: execution.args,
    execution: execution.execution,
  });
  upsertToolResultPart(sink.allParts, {
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
  for (const elicitationPart of execution.mcpElicitations ?? []) {
    // Mid-flight SSE already appended these; keep a single part reference so
    // status mutations from respondElicitation persist with the message.
    if (!sink.allParts.some((part) => part === elicitationPart)) {
      sink.allParts.push(elicitationPart);
    }
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

export function synchronizeToolProgressForCheckpoint(
  item: ToolExecutionProgressItem,
  parts: MessagePart[]
): void {
  if (item.kind === 'event') {
    const event = item.event;
    if (event.type === 'tool_execution') {
      upsertToolCallPart(parts, {
        type: 'tool_call',
        toolCallId: event.callId,
        name: event.name,
        args: {},
        execution: event.execution,
      });
    }
    if (
      event.type === 'mcp_elicitation' &&
      !parts.some(
        (part) => part.type === 'mcp_elicitation' && part.elicitationId === event.part.elicitationId
      )
    ) {
      parts.push(event.part);
    }
    return;
  }

  const execution = item.execution;
  upsertToolCallPart(parts, {
    type: 'tool_call',
    toolCallId: execution.callId,
    name: execution.name,
    args: execution.args,
    execution: execution.execution,
  });
  upsertToolResultPart(parts, {
    type: 'tool_result',
    toolCallId: execution.callId,
    content: execution.resultStr,
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
  checkpoint?: () => Promise<void>;
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
  let thrown: { error: unknown } | undefined;
  /** Images the generator never reached — see `abandonUnreachedImages`. */
  let abandonedCount = 0;

  // This path yields stream events directly instead of routing through the
  // async queue, so lifecycle transitions buffer here and drain between stages.
  const lifecycleEvents: ToolExecutionTransitionEvent[] = [];
  const lifecycle = new ToolExecutionLifecycle(callId, name, (event) =>
    lifecycleEvents.push(event)
  );
  lifecycle.emitQueued();

  // Upsert, not push: a provider that announced this call through
  // `tool_call_completed` already put a row for it in `allParts`, and pushing a
  // second one gave the turn two rows per image call — rendered as duplicate
  // steps under one React key, the first of them never settling because only
  // this one is updated when the tool returns.
  const toolCallPart = upsertToolCallPart(ctx.allParts, {
    type: 'tool_call',
    toolCallId: callId,
    name,
    args,
    execution: lifecycle.current,
  });
  yield* drainLifecycleEvents(lifecycleEvents);
  await ctx.checkpoint?.();

  try {
    const imageTool = getTool(name);
    if (!ctx.allowedToolNames.has(name)) {
      throw new ToolPolicyError(`Tool "${name}" is not allowed for this agent.`, 'not_allowed');
    }
    if (!imageTool) throw new ToolPolicyError(`Unknown tool: "${name}"`, 'unknown_tool');
    const effectiveSettings = getSafeEffectiveToolSettings(imageTool, ctx.toolSettings.get(name));
    if (!effectiveSettings.enabled) {
      throw new ToolPolicyError(`Tool "${name}" is disabled for this user.`, 'tool_disabled');
    }
    lifecycle.transition('running');
    toolCallPart.execution = lifecycle.current;
    yield* drainLifecycleEvents(lifecycleEvents);
    await ctx.checkpoint?.();

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
      await ctx.checkpoint?.();
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
        await ctx.checkpoint?.();
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
        await ctx.checkpoint?.();
      }
    }

    abandonedCount = yield* abandonUnreachedImages(imagePartsById, outcomes, callId);
    await ctx.checkpoint?.();

    const imageResult = summarizeGenerateImageToolResult(outcomes);
    result = imageResult;
    // A call cut short is a failed call even when some pictures landed: the
    // checkpoint files a `tool_result` without `isError` under succeeded calls,
    // so a partial abort would tell the resume prompt this call worked and drop
    // it off the retry list. The payload still carries `images` and `errors`,
    // so the model sees exactly how far the batch got.
    isError =
      abandonedCount > 0 ||
      (imageResult.images.length === 0 && (imageResult.errors?.length ?? 0) > 0);
  } catch (error) {
    result = { error: errorToToolMessage(error) };
    isError = true;
    thrown = { error };
  }

  if (thrown) {
    const failure = classifyToolExecutionFailure(thrown.error, ctx.signal);
    lifecycle.transition(failure.status, failure.reasonCode);
  } else if (isError) {
    // Two failures reach here without an exception. `generateImagesForToolPlan`
    // stops yielding rather than throwing, so the turn signal — not a caught
    // error — is what names the cause, and a call cut short is cancelled even
    // when the images it did reach came back: producing two of three pictures
    // is not the same as being asked for two. With nothing aborted this
    // classifies exactly as the plain `execution_error` it replaces.
    const failure = classifyToolExecutionFailure(undefined, ctx.signal);
    lifecycle.transition(failure.status, failure.reasonCode);
  } else {
    lifecycle.transition('succeeded');
  }
  toolCallPart.execution = lifecycle.current;
  yield* drainLifecycleEvents(lifecycleEvents);
  await ctx.checkpoint?.();

  const resultStr = stringifyToolResult(result);
  ctx.allParts.push({ type: 'tool_result', toolCallId: callId, content: resultStr, isError });
  await ctx.checkpoint?.();
  yield { type: 'tool_result', callId, name, result, isError };
  ctx.nextToolResults.push({ callId, name, result: resultStr, isError });
}

/**
 * Records a failed outcome for every planned image the generator never reached,
 * and streams the failure so the tab that started the call stops showing it as
 * generating.
 *
 * `generateImagesForToolPlan` stops at its abort check by returning rather than
 * throwing, and says nothing about the images it had left. Without this an
 * interrupted call summarizes to `count: 0` with no errors — which reads as a
 * call that succeeded and chose to produce nothing, and settles the lifecycle
 * as `succeeded` — while every unreached part stays at `generating` for the
 * life of the message, spinning on each reload. The browser's parts array is
 * separate from the API's, and only a completion/failure event moves a card
 * off `generating` there, so pushing to `outcomes` without also yielding
 * leaves the open tab spinning even though the API and a reload both agree
 * the image failed.
 *
 * A stop keeps the tab open for this to reach; a crash or a throw mid-batch
 * skips this function entirely, so the durable seal for a part left at
 * `generating` still lives in `reconcileInterruptedMessageParts` for that
 * case. What this adds on top of the tool result is the live signal: the
 * outcomes it pushes are how the model learns the batch was cut short, and
 * the events it yields are how the open tab learns the same thing without a
 * reload.
 *
 * Returns how many images were abandoned, which is what tells the caller the
 * call was cut short rather than finished.
 *
 * // Usage: const abandoned = yield* abandonUnreachedImages(imagePartsById, outcomes, callId);
 */
function* abandonUnreachedImages(
  imagePartsById: ReadonlyMap<string, GeneratedImagePart>,
  outcomes: GenerateImageToolOutcome[],
  toolCallId: string
): Generator<StreamEvent, number> {
  const reached = new Set(outcomes.map((outcome) => outcome.imageId));
  let abandoned = 0;

  for (const [imageId, part] of imagePartsById) {
    if (reached.has(imageId)) continue;
    part.status = 'error';
    part.error = IMAGE_ABANDONED_ERROR;
    outcomes.push({
      type: 'failed',
      imageId,
      prompt: part.prompt,
      error: IMAGE_ABANDONED_ERROR,
      createdAt: Date.now(),
    });
    yield {
      type: 'image_generation_failed',
      imageId,
      toolCallId,
      prompt: part.prompt,
      error: IMAGE_ABANDONED_ERROR,
    };
    abandoned += 1;
  }

  return abandoned;
}

/**
 * Writes a tool call into the turn's parts, merging onto the row that already
 * carries this `toolCallId` instead of adding a second one.
 *
 * Returns the part now held in the array, which is not always `next`: merging
 * builds a new object, and a caller that goes on to mutate the call — settling
 * its execution once the tool returns — has to hold the stored one or its
 * writes land on an orphan.
 *
 * // Usage: const stored = upsertToolCallPart(parts, { type: 'tool_call', ... });
 */
export function upsertToolCallPart(
  parts: MessagePart[],
  next: Extract<MessagePart, { type: 'tool_call' }>
): Extract<MessagePart, { type: 'tool_call' }> {
  const index = parts.findIndex(
    (part) => part.type === 'tool_call' && part.toolCallId === next.toolCallId
  );
  const current = index === -1 ? undefined : parts[index];
  // The narrowing arm is unreachable — `findIndex` already matched on the type
  // — but it must still append rather than hand back an unstored part: the
  // whole point of the return value is that a caller can mutate what is in the
  // array, and returning `next` without storing it silently breaks that.
  if (current?.type !== 'tool_call') {
    parts.push(next);
    return next;
  }
  const merged: Extract<MessagePart, { type: 'tool_call' }> = {
    ...current,
    ...next,
    args: Object.keys(next.args).length > 0 ? next.args : current.args,
  };
  parts[index] = merged;
  return merged;
}

export function upsertToolResultPart(
  parts: MessagePart[],
  next: Extract<MessagePart, { type: 'tool_result' }>
): void {
  const index = parts.findIndex(
    (part) => part.type === 'tool_result' && part.toolCallId === next.toolCallId
  );
  if (index === -1) {
    parts.push(next);
    return;
  }
  parts[index] = next;
}

function* drainLifecycleEvents(events: ToolExecutionTransitionEvent[]): Generator<StreamEvent> {
  while (events.length > 0) {
    const event = events.shift();
    if (event) yield event;
  }
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
 *
 * // Usage: const chars = computeTurnLocalCharCount(prompt, providerState);
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

/**
 * Force a terminal state onto any part still carrying a live snapshot, so a
 * partial/exhausted/errored/*successful* turn never persists a tool_call as
 * queued/running/awaiting_user, or a generated_image as `generating`. Runs
 * immediately before the assistant message is written.
 *
 * The image clause covers what `reconcileInterruptedMessageParts` cannot:
 * `finalizeSuccessfulTurn` never calls it, so a throw swallowed into an
 * `isError` tool result — which lets `generateText` return normally — would
 * otherwise settle a successful turn with the card stuck pulsing forever.
 *
 * // Usage: finalizeDanglingToolExecutions(session.allParts);
 */
export function finalizeDanglingToolExecutions(parts: MessagePart[]): void {
  for (const part of parts) {
    if (part.type === 'generated_image' && part.status === 'generating') {
      part.status = 'error';
      part.error = IMAGE_ABANDONED_ERROR;
      continue;
    }
    if (part.type !== 'tool_call' || !part.execution) continue;
    if (isTerminalToolExecutionStatus(part.execution.status)) continue;
    part.execution = applyToolExecutionTransition(part.execution, {
      status: 'cancelled',
      at: Date.now(),
      reasonCode: 'turn_aborted',
    });
  }
}
