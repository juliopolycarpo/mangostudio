import type {
  ContinuationReasonCode,
  MessagePart,
  ProviderType,
  ReasoningEffort,
} from '@mangostudio/shared';
import type { MultiAgentSettings } from '@mangostudio/shared/app-settings';
import { MAX_TOOL_ITERATIONS_DEFAULT } from '@mangostudio/shared/app-settings';
import { mergeMessageParts } from '@mangostudio/shared/generation';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { getErrorCode } from '../../../lib/error-code';
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
import type {
  AgentEvent,
  AgentTurnRequest,
  AIProvider,
  ChatTurnContext,
  GenerationConfig,
  ToolDefinition,
} from '../../../services/providers/types';
import { publishActivityInvalidation } from '../../../services/realtime/activity-invalidation';
import { GENERATE_IMAGE_TOOL_NAME } from '../../../services/tools/builtin/generate-image';
import type { WorkdirPolicy } from '../../../services/tools/types';
import { generateId } from '../../../utils/id';
import { resolveProviderRuntimeAttachments } from '../../attachments/application/runtime-attachment-resolver';
import { recordTurnCompletedActivity } from '../../chats/application/record-turn-activity';
import { loadHistory, loadRichHistory } from '../../messages/infrastructure/message-repository';
import {
  finalizeCheckpointedAiResponse,
  type PersistedGeneratedImageInput,
  persistTextTurnStart,
  updateChatAfterTurn,
} from '../infrastructure/conversation-persistence';
import type { ResolvedAgentRuntime } from './resolve-agent-runtime';
import type { ResolvedModel } from './resolve-model';
import { resolveTurnContext } from './resolve-turn-context';
import {
  createDelegationRuntime,
  executeStandardToolCallsWithProgress,
  type ToolExecutionProgressItem,
} from './standard-tool-execution';
import {
  collectToolExecutionResult,
  executeImageGenerationCall,
  finalizeDanglingToolExecutions,
  handleTurnCompleted,
  synchronizeToolProgressForCheckpoint,
  upsertToolCallPart,
  upsertToolResultPart,
} from './stream-text-turn-helpers';
import type { StreamEvent, StreamTextTurnInput } from './stream-text-turn-types';
import { parseToolArgs, stringifyToolResult } from './tool-result-utils';
import { createTurnCheckpointPart, TurnCheckpointWriter } from './turn-checkpoint';
import { reconcileInterruptedMessageParts, sealUnresolvedToolCalls } from './turn-recovery';

const TOOL_LOOP_EXHAUSTED_MESSAGE = 'The model exceeded the maximum number of tool interactions.';

const streamTextTurnLogger = createDiagnosticLogger('stream-text-turn');

/** Mutable session state threaded through all stream-text-turn stages. */
export interface StreamTextTurnSession {
  input: StreamTextTurnInput;
  db: Kysely<Database>;
  chatId: string;
  userId: string;
  environmentId: string;
  signal?: AbortSignal;
  userMsgId: string;
  aiMsgId: string;
  startTime: number;
  workdir: string | undefined;
  workdirPolicy: WorkdirPolicy | undefined;
  resolvedModel: ResolvedModel;
  provider: AIProvider;
  agentRuntime: ResolvedAgentRuntime;
  multiAgentSettings: MultiAgentSettings;
  toolDefs: ToolDefinition[];
  allowedToolNames: Set<string>;
  effectiveSystemPrompt: string | undefined;
  /** Pre-todo-injection prompt used for the continuation hash (see TurnContext). */
  continuationSystemPrompt: string | undefined;
  effectivePrompt: string;
  thinkingEnabled: boolean;
  reasoningEffort: ReasoningEffort;
  attachmentIds: string[];
  warmupPromise: Promise<void>;
  runtimeAttachments: Awaited<ReturnType<typeof resolveProviderRuntimeAttachments>>;
  allParts: MessagePart[];
  generatedImageArtifacts: PersistedGeneratedImageInput[];
  delegationState: { subagentCallCount: number };
  fullText: string;
  executionState: AgentTurnExecutionState;
  checkpoint: ReturnType<typeof createTurnCheckpointPart>;
  checkpointWriter: TurnCheckpointWriter;
}

interface DegradationContext {
  from: string;
  to: string;
  reason: string;
  reasonCode: ContinuationReasonCode;
  fromProvider?: ProviderType;
}

/** Agent-loop iteration state carried across tool-loop passes. */
interface AgentLoopState {
  rawProviderState: string | null;
  pendingToolResults: AgentTurnRequest['toolResults'];
  isFirstIteration: boolean;
  inThinkingSegment: boolean;
  pendingCalls: Map<string, { name: string; argsStr: string }>;
  turnCompleted: boolean;
  degradedThisTurn: boolean;
}

function buildLegacyGenerationConfig(session: StreamTextTurnSession): GenerationConfig {
  const runtimeSettings = session.agentRuntime.runtimeSettings;
  return {
    thinkingEnabled: session.thinkingEnabled,
    reasoningEffort: session.reasoningEffort,
    tools: session.toolDefs,
    toolSettings: serializeToolSettings(session.agentRuntime.toolSettingsByName),
    maxOutputTokens: runtimeSettings.maxOutputTokens,
    promptCachePreference: runtimeSettings.promptCachePreference,
    parallelToolCallsEnabled: runtimeSettings.parallelToolCallsEnabled,
    enableProviderCompaction: runtimeSettings.providerCompactionEnabled,
    providerCompactionThreshold: session.input.contextSettings?.warningThreshold,
  };
}

function serializeToolSettings(
  settingsByName: ResolvedAgentRuntime['toolSettingsByName'] | undefined
): GenerationConfig['toolSettings'] | undefined {
  if (!settingsByName?.size) return undefined;

  const serialized: NonNullable<GenerationConfig['toolSettings']> = {};
  for (const [name, settings] of settingsByName) {
    serialized[name] = {
      enabled: settings.enabled,
      parameters: settings.parameters,
    };
  }
  return serialized;
}

/**
 * Resolve turn context, persist the user message, start provider warmup, and
 * assemble the mutable session used by later stages. Attachment resolution and
 * the warmup await are deferred to {@link resolveTurnAttachments} so their
 * failures are handled inside the orchestrator's try/catch.
 */
export async function prepareStreamTextTurn(
  input: StreamTextTurnInput,
  db: Kysely<Database>
): Promise<StreamTextTurnSession> {
  const turnContext = await resolveTurnContext(input, db);
  const {
    resolvedModel,
    provider,
    agentRuntime,
    multiAgentSettings,
    toolDefinitions: toolDefs,
    allowedToolNames,
    effectiveSystemPrompt,
    continuationSystemPrompt,
    attachmentIds,
    workdir,
    workdirPolicy,
    chatId,
    userId,
    environmentId,
  } = turnContext;
  const { modelId } = resolvedModel;
  const runtimeSettings = agentRuntime.runtimeSettings;

  const warmupPromise = warmProviderForRequest(provider.providerType, {
    userId: input.userId,
    modelName: modelId,
    purpose: provider.generateAgentTurnStream ? 'agent-turn' : 'stream-text',
  });

  const now = Date.now();
  const userMsgId = input.preparedTurn?.userMessageId ?? generateId();
  const aiMsgId = input.preparedTurn?.assistantMessageId ?? generateId();
  const checkpoint =
    input.preparedTurn?.checkpoint ??
    createTurnCheckpointPart({
      turnId: aiMsgId,
      startedAt: now,
      provider: provider.providerType,
      modelName: modelId,
      agentId: agentRuntime.profile.id,
      agentName: agentRuntime.profile.name,
    });
  const allParts: MessagePart[] = [checkpoint];

  input.onTurnPrepared?.(aiMsgId);

  if (!input.preparedTurn) {
    await persistTextTurnStart(
      {
        userId: input.userId,
        userMessageId: userMsgId,
        assistantMessageId: aiMsgId,
        chatId: input.chatId,
        displayPrompt: input.prompt,
        attachmentIds,
        timestamp: now,
        interactionMode: 'agent',
        modelName: modelId,
        assistantParts: allParts,
      },
      db
    );
  }

  const session = {
    input,
    db,
    chatId,
    userId,
    environmentId,
    signal: input.signal,
    userMsgId,
    aiMsgId,
    startTime: now,
    workdir,
    workdirPolicy,
    resolvedModel,
    provider,
    agentRuntime,
    multiAgentSettings,
    toolDefs,
    allowedToolNames,
    effectiveSystemPrompt,
    continuationSystemPrompt,
    effectivePrompt: input.prompt,
    thinkingEnabled: runtimeSettings.thinkingEnabled ?? true,
    reasoningEffort: runtimeSettings.reasoningEffort ?? 'medium',
    attachmentIds,
    warmupPromise,
    runtimeAttachments: [],
    allParts,
    generatedImageArtifacts: [],
    delegationState: { subagentCallCount: 0 },
    fullText: '',
    executionState: {
      durableProviderState: null,
      turnLocalState: null,
    },
    checkpoint,
    checkpointWriter: null as unknown as TurnCheckpointWriter,
  } satisfies StreamTextTurnSession;
  session.checkpointWriter = new TurnCheckpointWriter({
    db,
    chatId,
    messageId: aiMsgId,
    checkpoint,
    getContent: () => ({
      text: session.fullText,
      parts: session.allParts,
      // Durable state only: turn-local state must never reach the message row,
      // and every finalizer persists the same narrow value.
      providerState: session.executionState.durableProviderState,
      generationTime: `${((Date.now() - session.startTime) / 1000).toFixed(1)}s`,
    }),
  });
  return session;
}

async function checkpointTurn(session: StreamTextTurnSession, force = false): Promise<void> {
  await session.checkpointWriter.checkpoint({ force });
}

/**
 * Resolve provider runtime attachments and await provider warmup. Runs inside
 * the orchestrator try/catch so a missing/invalid attachment is persisted as an
 * error response and clears stale provider state, rather than escaping uncaught.
 */
export async function resolveTurnAttachments(session: StreamTextTurnSession): Promise<void> {
  session.runtimeAttachments = await resolveProviderRuntimeAttachments(
    {
      attachmentIds: session.attachmentIds,
      userId: session.userId,
      chatId: session.chatId,
      messageId: session.userMsgId,
    },
    session.db
  );
  await session.warmupPromise;
}

/**
 * Yield continuation-degradation stream events and record the transition part.
 */
function* emitContinuationDegradation(
  session: StreamTextTurnSession,
  ctx: DegradationContext
): Generator<StreamEvent> {
  const { provider, resolvedModel, chatId } = session;
  const { modelId } = resolvedModel;

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
  session.allParts.push(transitionPart);
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

/**
 * Decide cross-turn continuation and yield any degradation events.
 */
async function* prepareAgentContinuation(
  session: StreamTextTurnSession
): AsyncGenerator<StreamEvent, string | null> {
  const { db, chatId, provider, agentRuntime, toolDefs, continuationSystemPrompt, resolvedModel } =
    session;
  const { modelId } = resolvedModel;

  const chatRow = await db
    .selectFrom('chats')
    .select('lastProviderState')
    .where('id', '=', chatId)
    .executeTakeFirst();
  const lastProviderState = chatRow?.lastProviderState ?? null;

  const decision = decideContinuation({
    lastProviderState,
    provider: provider.providerType,
    modelName: modelId,
    agentId: agentRuntime.profile.id,
    agentRuntimeHash: agentRuntime.runtimeHash,
    // Hashes the pre-todo-injection prompt: the todo section changes nearly
    // every turn during agent work, and hashing it in would degrade stateful
    // continuation to replay constantly. Providers hash the same base via
    // AgentTurnRequest.continuationSystemPrompt, keeping both sides aligned.
    systemPromptHash: computeSystemPromptHash(continuationSystemPrompt),
    toolsetHash: computeToolsetHash(toolDefs),
  });

  switch (decision.type) {
    case 'continue_with_cursor':
      logValidContinuation({
        chatId,
        provider: provider.providerType,
        model: modelId,
        mode: decision.envelope.mode,
      });
      return decision.providerState;
    case 'degrade_to_replay':
      yield* emitContinuationDegradation(session, {
        from: decision.previousMode,
        to: 'replay',
        reason: decision.reason,
        reasonCode: decision.reasonCode,
        fromProvider: decision.previousProvider,
      });
      await checkpointTurn(session, true);
      return null;
    case 'start_replay':
      return null;
  }
}

/**
 * Map one provider agent-stream event into stream output and session updates.
 */
export async function* emitAgentStreamEvent(
  session: StreamTextTurnSession,
  event: AgentEvent,
  loop: AgentLoopState,
  richHistory: ChatTurnContext[]
): AsyncGenerator<StreamEvent> {
  const {
    provider,
    resolvedModel,
    chatId,
    input,
    toolDefs,
    effectiveSystemPrompt,
    executionState,
  } = session;
  const { modelId } = resolvedModel;

  switch (event.type) {
    case 'reasoning_delta':
      // A delta with no text is not a withheld reasoning phase, and this path
      // has no way to say it is one: `thinking_start` is synthesized from the
      // first delta rather than announced by the provider, unlike an external
      // turn's `reasoning_started`. Opening a segment for it stored an empty
      // `thinking` part that rendered as "reasoning not shared", claiming the
      // model withheld reasoning it never produced. The legacy arm below has
      // always guarded its text this way; two adapters already drop these at
      // the source, and the two that do not pass the vendor's value verbatim.
      if (!event.text) break;
      if (!loop.inThinkingSegment) {
        loop.inThinkingSegment = true;
        yield { type: 'thinking_start' };
      }
      session.allParts.push({ type: 'thinking', text: event.text });
      yield { type: 'thinking', text: event.text };
      await checkpointTurn(session);
      break;

    case 'tool_call_started':
      loop.inThinkingSegment = false;
      loop.pendingCalls.set(event.callId, { name: event.name ?? '', argsStr: '' });
      upsertToolCallPart(session.allParts, {
        type: 'tool_call',
        toolCallId: event.callId,
        name: event.name ?? '',
        args: {},
      });
      yield { type: 'tool_call_started', callId: event.callId, name: event.name ?? '' };
      await checkpointTurn(session, true);
      break;

    case 'tool_call_arguments_delta': {
      const call = loop.pendingCalls.get(event.callId);
      if (call) call.argsStr += event.delta;
      break;
    }

    case 'tool_call_completed':
      loop.pendingCalls.set(event.callId, { name: event.name, argsStr: event.arguments });
      upsertToolCallPart(session.allParts, {
        type: 'tool_call',
        toolCallId: event.callId,
        name: event.name,
        args: parseToolArgs(event.arguments),
      });
      yield {
        type: 'tool_call_completed',
        callId: event.callId,
        name: event.name,
        arguments: event.arguments,
      };
      await checkpointTurn(session, true);
      break;

    case 'tool_result': {
      // Only providers that run their own tool loop (e.g. Cursor's sidecar)
      // emit tool_result; the result marks the call satisfied so the
      // orchestrator must not re-execute it.
      if (!resolvedModel.capabilities?.internalAgentTools) break;
      loop.inThinkingSegment = false;
      const satisfiedCall = loop.pendingCalls.get(event.callId);
      if (satisfiedCall) {
        loop.pendingCalls.delete(event.callId);
        upsertToolCallPart(session.allParts, {
          type: 'tool_call',
          toolCallId: event.callId,
          name: satisfiedCall.name || event.name,
          args: parseToolArgs(satisfiedCall.argsStr),
        });
      }
      upsertToolResultPart(session.allParts, {
        type: 'tool_result',
        toolCallId: event.callId,
        content:
          typeof event.result === 'string' ? event.result : stringifyToolResult(event.result),
        isError: event.isError ?? false,
      });
      yield {
        type: 'tool_result',
        callId: event.callId,
        name: event.name,
        result: event.result,
        isError: event.isError ?? false,
      };
      await checkpointTurn(session, true);
      break;
    }

    case 'assistant_text_delta':
      loop.inThinkingSegment = false;
      session.fullText += event.text;
      session.allParts.push({ type: 'text', text: event.text });
      yield { type: 'text', text: event.text };
      await checkpointTurn(session);
      break;

    case 'turn_completed':
      loop.inThinkingSegment = false;
      loop.rawProviderState = event.providerState ?? null;
      loop.turnCompleted = true;
      yield* handleTurnCompleted({
        db: session.db,
        providerType: provider.providerType,
        modelId,
        chatId,
        prompt: input.prompt,
        richHistory,
        effectiveSystemPrompt,
        toolDefs,
        rawProviderState: loop.rawProviderState,
        degradedThisTurn: loop.degradedThisTurn,
        executionState,
      });
      await checkpointTurn(session, true);
      break;

    case 'continuation_degraded':
      loop.degradedThisTurn = true;
      // A transition part is about to sit between whatever reasoning ran
      // before it and whatever runs after, the same way a tool call would —
      // see every other case here. Left stale, the next `reasoning_delta`
      // skips `thinking_start`, and a client that relies on it to open a new
      // segment (rather than reopening one structurally, like this reducer's
      // frontend counterpart) welds the resumed reasoning onto the phase the
      // transition just ended.
      loop.inThinkingSegment = false;
      yield* emitContinuationDegradation(session, {
        from: event.from,
        to: event.to,
        reason: event.reason,
        reasonCode: event.reasonCode,
      });
      await checkpointTurn(session, true);
      break;

    case 'turn_error':
      throw new Error(event.error);
  }
}

function createAgentLoopState(rawProviderState: string | null): AgentLoopState {
  return {
    rawProviderState,
    pendingToolResults: undefined,
    isFirstIteration: true,
    inThinkingSegment: false,
    pendingCalls: new Map(),
    turnCompleted: false,
    degradedThisTurn: false,
  };
}

/**
 * Execute pending tool calls from one agent iteration, yielding progress events.
 */
async function* executePendingToolCalls(
  session: StreamTextTurnSession,
  pendingCallEntries: [string, { name: string; argsStr: string }][],
  nextToolResults: NonNullable<AgentTurnRequest['toolResults']>
): AsyncGenerator<StreamEvent> {
  const {
    db,
    userId,
    chatId,
    environmentId,
    agentRuntime,
    multiAgentSettings,
    allowedToolNames,
    workdir,
    workdirPolicy,
    resolvedModel,
    delegationState,
    signal,
  } = session;
  const toolSettings = agentRuntime.toolSettingsByName;
  const { modelId } = resolvedModel;

  const delegationRuntime = createDelegationRuntime({
    db,
    userId,
    chatId,
    environmentId,
    assistantMessageId: session.aiMsgId,
    parentAgentProfile: agentRuntime.profile,
    parentModelName: modelId,
    workdir,
    workdirPolicy,
    settings: multiAgentSettings,
    signal,
    state: delegationState,
  });

  const hasImageGenerationCall = pendingCallEntries.some(
    ([, call]) => call.name === GENERATE_IMAGE_TOOL_NAME
  );

  if (!hasImageGenerationCall) {
    for await (const item of executeStandardToolCallsWithProgress(pendingCallEntries, {
      userId,
      chatId,
      environmentId,
      assistantMessageId: session.aiMsgId,
      workdir,
      workdirPolicy,
      settingsByToolName: toolSettings,
      allowedToolNames,
      delegationRuntime,
      db,
      signal,
    })) {
      synchronizeToolProgressForCheckpoint(item, session.allParts);
      yield* collectToolExecutionResult(item, {
        allParts: session.allParts,
        nextToolResults,
        includeSubagentTrace: multiAgentSettings.traceVisibility !== 'off',
      });
      await checkpointTurn(session, true);
    }
    return;
  }

  const nonImageEntries = pendingCallEntries.filter(
    ([, call]) => call.name !== GENERATE_IMAGE_TOOL_NAME
  );
  const imageEntries = pendingCallEntries.filter(
    ([, call]) => call.name === GENERATE_IMAGE_TOOL_NAME
  );

  const nonImageResultEntries: ToolExecutionProgressItem[] = [];
  const nonImageRunner =
    nonImageEntries.length > 0
      ? (async () => {
          for await (const item of executeStandardToolCallsWithProgress(nonImageEntries, {
            userId,
            chatId,
            environmentId,
            assistantMessageId: session.aiMsgId,
            workdir,
            workdirPolicy,
            settingsByToolName: toolSettings,
            allowedToolNames,
            delegationRuntime,
            db,
            signal,
          })) {
            synchronizeToolProgressForCheckpoint(item, session.allParts);
            await checkpointTurn(session, true);
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
      allParts: session.allParts,
      generatedImageArtifacts: session.generatedImageArtifacts,
      nextToolResults,
      checkpoint: () => checkpointTurn(session, true),
    });
  }

  if (nonImageRunner) await nonImageRunner;
  for (const item of nonImageResultEntries) {
    // Already projected into allParts as it streamed in above.
    yield* collectToolExecutionResult(item, {
      allParts: session.allParts,
      nextToolResults,
      includeSubagentTrace: multiAgentSettings.traceVisibility !== 'off',
    });
    await checkpointTurn(session, true);
  }
}

/**
 * Run the agent turn tool loop: stream provider events and execute tool calls
 * until the model finishes, aborts, or hits the iteration cap.
 */
export async function* runAgentToolLoop(
  session: StreamTextTurnSession
): AsyncGenerator<StreamEvent, { exhausted: boolean; pendingCallCount: number }> {
  const {
    provider,
    agentRuntime,
    resolvedModel,
    toolDefs,
    effectiveSystemPrompt,
    effectivePrompt,
    runtimeAttachments,
    chatId,
    userId,
    environmentId,
    signal,
    input,
  } = session;
  const { modelId, capabilities } = resolvedModel;
  const runtimeSettings = agentRuntime.runtimeSettings;
  const maxIter = runtimeSettings.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT;

  const richHistory = await loadRichHistory(
    chatId,
    { excludeIds: [session.userMsgId, session.aiMsgId] },
    session.db
  );
  const initialProviderState = yield* prepareAgentContinuation(session);

  const generateAgentTurnStream = provider.generateAgentTurnStream;
  if (!generateAgentTurnStream) {
    return { exhausted: false, pendingCallCount: 0 };
  }
  const boundAgentTurnStream = generateAgentTurnStream.bind(provider);

  const loop = createAgentLoopState(initialProviderState);

  for (let iteration = 0; iteration < maxIter; iteration++) {
    if (signal?.aborted) break;

    const req: AgentTurnRequest = {
      userId,
      chatId,
      environmentId,
      assistantMessageId: session.aiMsgId,
      workdir: session.workdir,
      workdirPolicy: session.workdirPolicy,
      modelName: modelId,
      agentId: agentRuntime.profile.id,
      agentRuntimeHash: agentRuntime.runtimeHash,
      systemPrompt: effectiveSystemPrompt,
      continuationSystemPrompt: session.continuationSystemPrompt,
      history: richHistory,
      prompt: loop.isFirstIteration ? effectivePrompt : undefined,
      toolResults: loop.pendingToolResults,
      toolDefinitions: toolDefs,
      providerState: loop.rawProviderState,
      signal,
      attachments: loop.isFirstIteration ? runtimeAttachments : undefined,
      modelCapabilities: capabilities,
      generationConfig: {
        thinkingEnabled: session.thinkingEnabled,
        reasoningEffort: session.reasoningEffort,
        toolSettings: serializeToolSettings(agentRuntime.toolSettingsByName),
        maxToolIterations: maxIter,
        maxOutputTokens: runtimeSettings.maxOutputTokens,
        promptCachePreference: runtimeSettings.promptCachePreference,
        parallelToolCallsEnabled: runtimeSettings.parallelToolCallsEnabled,
        enableProviderCompaction: runtimeSettings.providerCompactionEnabled,
        providerCompactionThreshold: input.contextSettings?.warningThreshold,
      },
    };

    loop.pendingCalls = new Map();
    loop.turnCompleted = false;
    loop.degradedThisTurn = false;

    for await (const event of boundAgentTurnStream(req)) {
      if (signal?.aborted) break;
      yield* emitAgentStreamEvent(session, event, loop, richHistory);
    }

    if (signal?.aborted || !loop.turnCompleted) break;
    if (loop.pendingCalls.size === 0) break;

    const nextToolResults: NonNullable<AgentTurnRequest['toolResults']> = [];
    const pendingCallEntries = Array.from(loop.pendingCalls.entries());
    yield* executePendingToolCalls(session, pendingCallEntries, nextToolResults);

    loop.pendingToolResults = nextToolResults;
    loop.isFirstIteration = false;
  }

  const exhausted = loop.pendingCalls.size > 0 && !signal?.aborted;
  return { exhausted, pendingCallCount: loop.pendingCalls.size };
}

/**
 * Stream text from a legacy provider that exposes generateTextStream.
 */
export async function* runLegacyTextStream(
  session: StreamTextTurnSession
): AsyncGenerator<StreamEvent> {
  const {
    provider,
    chatId,
    userId,
    effectivePrompt,
    effectiveSystemPrompt,
    resolvedModel,
    signal,
  } = session;
  const { modelId, capabilities } = resolvedModel;

  const history = await loadHistory(
    chatId,
    { excludeIds: [session.userMsgId, session.aiMsgId] },
    session.db
  );
  let legacyInThinking = false;

  const generateTextStream = provider.generateTextStream;
  if (!generateTextStream) return;

  for await (const chunk of generateTextStream({
    userId,
    environmentId: session.environmentId,
    chatId,
    assistantMessageId: session.aiMsgId,
    workdir: session.workdir,
    workdirPolicy: session.workdirPolicy,
    history,
    prompt: effectivePrompt,
    systemPrompt: effectiveSystemPrompt,
    modelName: modelId,
    signal,
    generationConfig: buildLegacyGenerationConfig(session),
    attachments: session.runtimeAttachments,
    modelCapabilities: capabilities,
  })) {
    if (signal?.aborted) break;

    if (chunk.type === 'error') {
      throw new Error(chunk.content ?? 'Stream generation failed');
    }

    if (chunk.type === 'thinking' && chunk.text) {
      if (!legacyInThinking) {
        legacyInThinking = true;
        yield { type: 'thinking_start' };
      }
      session.allParts.push({ type: 'thinking', text: chunk.text });
      yield { type: 'thinking', text: chunk.text };
      await checkpointTurn(session);
    } else if (chunk.type === 'text' && chunk.text && !chunk.done) {
      legacyInThinking = false;
      session.fullText += chunk.text;
      session.allParts.push({ type: 'text', text: chunk.text });
      yield { type: 'text', text: chunk.text };
      await checkpointTurn(session);
    } else if (chunk.type === 'tool_call') {
      // Coarse marker for legacy-path providers without generateAgentTurnStream;
      // agent-turn providers surface real tool_call/tool_result parts instead.
      const detail = chunk.name ?? 'tool';
      const eventName = `${provider.providerType}_internal_tool_call`;
      legacyInThinking = false;
      session.allParts.push({ type: 'system_event', event: eventName, detail });
      yield { type: 'system_event', event: eventName, detail };
      await checkpointTurn(session, true);
    }
  }
}

/**
 * Generate a single non-streaming text response from the provider.
 */
export async function* runSingleShotTextGeneration(
  session: StreamTextTurnSession
): AsyncGenerator<StreamEvent> {
  const {
    provider,
    chatId,
    userId,
    effectivePrompt,
    effectiveSystemPrompt,
    resolvedModel,
    signal,
  } = session;
  const { modelId, capabilities } = resolvedModel;

  const history = await loadHistory(
    chatId,
    { excludeIds: [session.userMsgId, session.aiMsgId] },
    session.db
  );

  const generateText = provider.generateText;
  if (!generateText) return;

  const result = await generateText({
    userId,
    environmentId: session.environmentId,
    chatId,
    workdir: session.workdir,
    workdirPolicy: session.workdirPolicy,
    history,
    prompt: effectivePrompt,
    systemPrompt: effectiveSystemPrompt,
    modelName: modelId,
    signal,
    generationConfig: buildLegacyGenerationConfig(session),
    attachments: session.runtimeAttachments,
    modelCapabilities: capabilities,
  });

  if (!signal?.aborted) {
    session.fullText = result.text;
    session.allParts.push({ type: 'text', text: result.text });
    yield { type: 'text', text: session.fullText };
    await checkpointTurn(session, true);
  }
}

/**
 * Clear stale chat-level provider state when no durable cursor was produced.
 */
export async function clearStaleProviderState(session: StreamTextTurnSession): Promise<void> {
  if (session.signal?.aborted || session.executionState.durableProviderState) return;

  await session.db
    .updateTable('chats')
    .set({ lastProviderState: null })
    .where('id', '=', session.chatId)
    .execute()
    .catch((err) => {
      logStateCleared({
        chatId: session.chatId,
        reason: 'no_durable_state',
        error: String(err),
      });
    });
}

/**
 * Persist a successful turn and emit the done event.
 */
export async function* finalizeSuccessfulTurn(
  session: StreamTextTurnSession
): AsyncGenerator<StreamEvent> {
  const {
    db,
    aiMsgId,
    userId,
    chatId,
    startTime,
    resolvedModel,
    generatedImageArtifacts,
    executionState,
  } = session;
  const { modelId } = resolvedModel;

  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  const aiTimestamp = Date.now();

  for (const part of session.allParts) {
    if (part.type === 'continuation_transition') {
      part.recovered = true;
    }
  }

  finalizeDanglingToolExecutions(session.allParts);
  await session.checkpointWriter.prepareFinal('completed');
  sealUnresolvedToolCalls(session.allParts);
  const finalParts = mergeMessageParts(session.allParts);

  const finalized = await finalizeCheckpointedAiResponse(
    {
      id: aiMsgId,
      userId,
      chatId,
      text: session.fullText,
      parts: finalParts,
      providerState: executionState.durableProviderState,
      generationTime,
      modelName: modelId,
      generatedImages: generatedImageArtifacts,
    },
    db
  );
  if (!finalized) return;

  await updateChatAfterTurn(chatId, aiTimestamp, db);
  void recordTurnCompletedActivity(userId, chatId, db);

  yield { type: 'done', messageId: aiMsgId, generationTime };
}

/**
 * Handle tool-loop exhaustion: clear state, persist error, and emit events.
 */
export async function* finalizeToolLoopExhausted(
  session: StreamTextTurnSession,
  pendingCallCount: number
): AsyncGenerator<StreamEvent> {
  const {
    db,
    aiMsgId,
    userId,
    chatId,
    startTime,
    agentRuntime,
    resolvedModel,
    generatedImageArtifacts,
    executionState,
  } = session;
  const { modelId } = resolvedModel;
  const maxIter = agentRuntime.runtimeSettings.maxToolIterations ?? MAX_TOOL_ITERATIONS_DEFAULT;

  const detail = `Reached ${maxIter} iterations with ${pendingCallCount} pending tool calls`;
  session.allParts.push({ type: 'system_event', event: 'tool_loop_exhausted', detail });
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
  reconcileInterruptedMessageParts(session.allParts);
  session.allParts.push({ type: 'error', text: TOOL_LOOP_EXHAUSTED_MESSAGE });
  // The failure text is a placeholder for the row, never durable assistant
  // output: writing it into `fullText` would republish it to the resume prompt
  // as authoritative content the model believes it produced.
  await session.checkpointWriter.prepareFinal('interrupted', 'tool_loop_exhausted');
  sealUnresolvedToolCalls(session.allParts);
  const errorParts = mergeMessageParts(session.allParts);

  try {
    const finalized = await finalizeCheckpointedAiResponse(
      {
        id: aiMsgId,
        userId,
        chatId,
        text: session.fullText || TOOL_LOOP_EXHAUSTED_MESSAGE,
        parts: errorParts,
        providerState: executionState.durableProviderState,
        generationTime,
        modelName: modelId,
        generatedImages: generatedImageArtifacts,
      },
      db
    );
    if (!finalized) return;
    await updateChatAfterTurn(chatId, Date.now(), db);
    publishActivityInvalidation(userId);
  } catch {
    // best-effort
  }
}

/**
 * Handle an unexpected turn failure: clear stale state, persist error, emit event.
 */
export async function* finalizeTurnError(
  session: StreamTextTurnSession,
  error: unknown
): AsyncGenerator<StreamEvent> {
  const {
    signal,
    chatId,
    db,
    executionState,
    aiMsgId,
    userId,
    startTime,
    resolvedModel,
    generatedImageArtifacts,
  } = session;

  if (signal?.aborted) {
    await finalizeInterruptedTurn(session, getAbortInterruptionReason(signal));
    return;
  }

  const message = error instanceof Error ? error.message : 'Stream generation failed';
  const code = getErrorCode(error);
  streamTextTurnLogger.error('turn_failed', { chatId, message });

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
    reconcileInterruptedMessageParts(session.allParts);
    session.allParts.push({ type: 'error', text: message });
    // See finalizeToolLoopExhausted: the error text must not reach `fullText`,
    // which the checkpoint republishes as durable assistant output on resume.
    await session.checkpointWriter.prepareFinal('interrupted', 'provider_error');
    sealUnresolvedToolCalls(session.allParts);
    const errorParts = mergeMessageParts(session.allParts);
    const finalized = await finalizeCheckpointedAiResponse(
      {
        id: aiMsgId,
        userId,
        chatId,
        text: session.fullText || message,
        parts: errorParts,
        providerState: executionState.durableProviderState,
        generationTime,
        modelName: resolvedModel.modelId,
        generatedImages: generatedImageArtifacts,
      },
      db
    );
    if (finalized) {
      await updateChatAfterTurn(chatId, Date.now(), db);
      publishActivityInvalidation(userId);
    }
  } catch {
    // best-effort
  }

  yield { type: 'error', error: message, ...(code ? { code } : {}) };
}

export async function finalizeInterruptedTurn(
  session: StreamTextTurnSession,
  reasonCode: 'client_disconnect' | 'user_cancelled' | 'unknown'
): Promise<void> {
  const {
    db,
    aiMsgId,
    userId,
    chatId,
    startTime,
    resolvedModel,
    generatedImageArtifacts,
    executionState,
  } = session;
  reconcileInterruptedMessageParts(session.allParts);
  const generationTime = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;
  await session.checkpointWriter.prepareFinal('interrupted', reasonCode);
  sealUnresolvedToolCalls(session.allParts);
  const finalized = await finalizeCheckpointedAiResponse(
    {
      id: aiMsgId,
      userId,
      chatId,
      text: session.fullText,
      parts: mergeMessageParts(session.allParts),
      providerState: executionState.durableProviderState,
      generationTime,
      modelName: resolvedModel.modelId,
      generatedImages: generatedImageArtifacts,
    },
    db
  );
  if (!finalized) return;
  await updateChatAfterTurn(chatId, Date.now(), db);
  publishActivityInvalidation(userId);
}

export function getAbortInterruptionReason(
  signal: AbortSignal
): 'client_disconnect' | 'user_cancelled' | 'unknown' {
  const reason = signal.reason;
  if (reason === 'client_disconnect' || reason === 'user_cancelled') return reason;
  return 'unknown';
}
