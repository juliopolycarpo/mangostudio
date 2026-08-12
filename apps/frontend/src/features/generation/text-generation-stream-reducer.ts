import type { GeneratedImagePart, Message, MessagePart } from '@mangostudio/shared';
import type {
  ExternalAccountLimits,
  ExternalAgentError,
  ExternalAgentTargetId,
  ExternalThreadUsage,
  ExternalTurnTerminalReason,
  ExternalUsage,
} from '@mangostudio/shared/external-agents';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type {
  ExternalActivityPart,
  ExternalTurnPart,
  SubagentTraceEvent,
  SubagentTraceEventName,
} from '@mangostudio/shared/types';
import { mergeSubagentTraceEvents } from '@mangostudio/shared/types';

interface TextGenerationStreamReducerOptions {
  readonly pendingSubagentName: string;
}

interface CreateTextGenerationStreamStateOptions {
  readonly userMessageId: string;
  readonly aiMessageId: string;
}

export interface TextGenerationStreamMessageUpdate {
  readonly targetMessageId: string;
  readonly patch: Partial<Message>;
}

export interface TextGenerationStreamState {
  readonly text: string;
  readonly parts: MessagePart[];
  readonly currentUserMessageId: string;
  readonly currentAiMessageId: string;
  readonly receivedServerUserMessageId: boolean;
  readonly receivedServerAiMessageId: boolean;
  readonly activeThinkingIndex: number | null;
  readonly userMessageUpdate: TextGenerationStreamMessageUpdate | null;
  readonly aiMessageUpdate: TextGenerationStreamMessageUpdate | null;
  /** Cumulative thread usage from the vendor — separate from per-turn `usage` on the turn part. */
  readonly threadUsage: ExternalThreadUsage | null;
  /** Latest account-quota snapshot observed on this stream. */
  readonly accountLimits: ExternalAccountLimits | null;
}

interface ParsedSubagentEvent {
  readonly callId: string;
  readonly agentId?: string;
  readonly event: SubagentTraceEventName;
  readonly attempt?: number;
  readonly detail?: string;
}

const SUBAGENT_SYSTEM_EVENTS: Readonly<Record<string, SubagentTraceEventName>> = {
  subagent_delegation_started: 'delegation_started',
  subagent_delegation_completed: 'delegation_completed',
  subagent_delegation_failed: 'delegation_failed',
  subagent_response_attempt: 'response_attempt',
  subagent_response_recovered: 'response_recovered',
  subagent_response_timeout: 'response_timeout',
  subagent_response_fallback: 'response_fallback',
};

/** Creates the initial reducer state for one streamed text generation turn.
 * Usage: `const state = createTextGenerationStreamState({ userMessageId, aiMessageId })`
 */
export function createTextGenerationStreamState({
  userMessageId,
  aiMessageId,
}: CreateTextGenerationStreamStateOptions): TextGenerationStreamState {
  return {
    text: '',
    parts: [],
    currentUserMessageId: userMessageId,
    currentAiMessageId: aiMessageId,
    receivedServerUserMessageId: false,
    receivedServerAiMessageId: false,
    activeThinkingIndex: null,
    userMessageUpdate: null,
    aiMessageUpdate: null,
    threadUsage: null,
    accountLimits: null,
  };
}

/** Reduces one streamed chunk into the next optimistic text generation state.
 * Usage: `state = reduceTextGenerationStreamChunk(state, chunk, { pendingSubagentName })`
 */
export function reduceTextGenerationStreamChunk(
  state: TextGenerationStreamState,
  chunk: StreamChunk,
  options: TextGenerationStreamReducerOptions
): TextGenerationStreamState {
  const nextState = clearChunkUpdates(state);

  switch (chunk.type) {
    case 'user_message_id':
      return withUserMessageUpdate(nextState, { id: chunk.messageId }, chunk.messageId, true);
    case 'assistant_message_id':
      return withAiMessageUpdate(nextState, { id: chunk.messageId }, chunk.messageId, true);
    case 'error':
      return reduceStreamError(nextState, chunk.error);
    case 'thinking_start':
      return reduceThinkingStart(nextState);
    case 'thinking':
      return reduceThinkingDelta(nextState, chunk.text);
    case 'text':
      return reduceTextDelta(nextState, chunk.text);
    case 'tool_call_started':
      return reduceToolCallStarted(nextState, chunk.callId, chunk.name);
    case 'tool_call_completed':
      return reduceToolCallCompleted(nextState, chunk.callId, chunk.arguments);
    case 'tool_result':
      return reduceToolResult(nextState, chunk.callId, chunk.result, chunk.isError);
    case 'tool_execution':
      return reduceToolExecution(nextState, chunk);
    case 'subagent_started':
      return reduceSubagentStarted(nextState, chunk);
    case 'subagent_text':
      return reduceSubagentText(nextState, chunk.callId, chunk.text);
    case 'subagent_tool_call_started':
      return reduceSubagentToolCallStarted(nextState, chunk.callId, chunk.toolCallId, chunk.name);
    case 'subagent_completed':
      return reduceSubagentCompleted(nextState, chunk.callId, chunk.summary, chunk.toolCallCount);
    case 'subagent_failed':
      return reduceSubagentFailed(nextState, chunk.callId, chunk.error);
    case 'mcp_media':
      return reduceMcpMedia(nextState, chunk);
    case 'question':
      return reduceQuestion(nextState, chunk);
    case 'mcp_elicitation_request':
      return reduceMcpElicitation(nextState, chunk);
    case 'mcp_elicitation_status':
      return reduceMcpElicitationStatus(nextState, chunk);
    case 'todo_update':
      return reduceTodoUpdate(nextState, chunk);
    case 'image_generation_started':
      return reduceImageGenerationStarted(nextState, chunk);
    case 'image_generation_completed':
      return reduceImageGenerationCompleted(nextState, chunk);
    case 'image_generation_failed':
      return reduceImageGenerationFailed(nextState, chunk);
    case 'continuation_transition':
      return reduceContinuationTransition(nextState, chunk);
    case 'system_event':
      return reduceSystemEvent(nextState, chunk.event, chunk.detail, options.pendingSubagentName);
    case 'external_session_started':
      return reduceExternalSessionStarted(nextState, chunk);
    case 'external_text':
      return reduceExternalText(nextState, chunk.text);
    case 'external_reasoning':
      return reduceExternalReasoning(nextState, chunk.text);
    case 'external_activity_started':
      return reduceExternalActivityStarted(nextState, chunk);
    case 'external_activity_updated':
      return reduceExternalActivityUpdated(nextState, chunk);
    case 'external_activity_completed':
      return reduceExternalActivityCompleted(nextState, chunk);
    case 'external_approval_request':
      return reduceExternalApprovalRequest(nextState, chunk);
    case 'external_approval_status':
      return reduceExternalApprovalStatus(nextState, chunk);
    case 'external_usage':
      return reduceExternalUsage(nextState, chunk.usage);
    case 'external_thread_usage':
      return reduceExternalThreadUsage(nextState, chunk.usage);
    case 'external_account_limits':
      return { ...nextState, accountLimits: chunk.limits };
    case 'external_steer':
      return reduceExternalSteer(nextState, chunk);
    case 'external_error':
      return reduceExternalError(nextState, chunk.error);
    case 'external_turn_completed':
      return reduceExternalTurnCompleted(nextState, chunk.reason);
    case 'done':
      return reduceDone(nextState, chunk.messageId, chunk.generationTime);
    case 'context_info':
    case 'fallback_notice':
      return nextState;
    default: {
      const _exhaustive: never = chunk;
      return _exhaustive;
    }
  }
}

function clearChunkUpdates(state: TextGenerationStreamState): TextGenerationStreamState {
  return { ...state, userMessageUpdate: null, aiMessageUpdate: null };
}

function reduceStreamError(state: TextGenerationStreamState, errorText: string) {
  const parts = [...state.parts, { type: 'error', text: errorText } satisfies MessagePart];
  return withAiMessageUpdate(
    { ...state, parts },
    { isGenerating: false, text: state.text || errorText, parts }
  );
}

function reduceThinkingStart(state: TextGenerationStreamState) {
  const parts = [...state.parts, { type: 'thinking', text: '' } satisfies MessagePart];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: parts.length - 1 }, { parts });
}

function reduceThinkingDelta(state: TextGenerationStreamState, text: string) {
  const initializedState = state.activeThinkingIndex === null ? reduceThinkingStart(state) : state;
  const thinkingIndex = initializedState.activeThinkingIndex;
  if (thinkingIndex === null) return initializedState;
  const currentPart = initializedState.parts[thinkingIndex];
  const currentText = currentPart?.type === 'thinking' ? currentPart.text : '';
  const parts = replacePartAt(initializedState.parts, thinkingIndex, {
    type: 'thinking',
    text: `${currentText}${text}`,
  });
  return withAiMessageUpdate({ ...initializedState, parts }, { parts });
}

function reduceTextDelta(state: TextGenerationStreamState, textDelta: string) {
  const text = `${state.text}${textDelta}`;
  const parts = upsertTextPart(state.parts, text);
  return withAiMessageUpdate({ ...state, text, parts, activeThinkingIndex: null }, { text, parts });
}

function reduceToolCallStarted(state: TextGenerationStreamState, callId: string, name: string) {
  const parts = [
    ...state.parts,
    { type: 'tool_call', toolCallId: callId, name, args: {} } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceToolCallCompleted(
  state: TextGenerationStreamState,
  callId: string,
  argumentsText: string
) {
  const parsedArgs = parseToolArguments(argumentsText);
  const parts = state.parts.map((part) =>
    part.type === 'tool_call' && part.toolCallId === callId ? { ...part, args: parsedArgs } : part
  );
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceToolResult(
  state: TextGenerationStreamState,
  callId: string,
  result: unknown,
  isError: boolean | undefined
) {
  const parts = [
    ...state.parts,
    {
      type: 'tool_result',
      toolCallId: callId,
      content: JSON.stringify(result),
      isError,
    } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceToolExecution(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'tool_execution' }>
) {
  const exists = state.parts.some(
    (part) => part.type === 'tool_call' && part.toolCallId === chunk.callId
  );
  // The queued transition normally follows tool_call_started, so the part
  // exists; a missing part (e.g. provider skipped start events) is created so
  // the lifecycle is never dropped.
  const parts = exists
    ? state.parts.map((part) =>
        part.type === 'tool_call' && part.toolCallId === chunk.callId
          ? { ...part, execution: chunk.execution }
          : part
      )
    : [
        ...state.parts,
        {
          type: 'tool_call',
          toolCallId: chunk.callId,
          name: chunk.name,
          args: {},
          execution: chunk.execution,
        } satisfies MessagePart,
      ];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSubagentStarted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'subagent_started' }>
) {
  const parts = upsertSubagentTracePart(state.parts, {
    type: 'subagent_trace',
    toolCallId: chunk.callId,
    agentId: chunk.agentId,
    agentName: chunk.agentName,
    status: 'running',
    summary: chunk.task,
    toolCallCount: 0,
    messages: [],
    tools: [],
  });
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSubagentText(state: TextGenerationStreamState, callId: string, text: string) {
  const parts = updateSubagentTracePart(state.parts, callId, (part) => {
    const previous = part.messages.at(-1);
    const messages =
      previous?.role === 'assistant'
        ? [
            ...part.messages.slice(0, -1),
            { role: 'assistant' as const, text: `${previous.text}${text}` },
          ]
        : [...part.messages, { role: 'assistant' as const, text }];
    const lastMessage = messages.at(-1)?.text;
    return { ...part, ...(lastMessage ? { lastMessage } : {}), messages };
  });
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSubagentToolCallStarted(
  state: TextGenerationStreamState,
  callId: string,
  toolCallId: string,
  name: string
) {
  const parts = updateSubagentTracePart(state.parts, callId, (part) => ({
    ...part,
    toolCallCount: part.toolCallCount + 1,
    tools: [...part.tools, { callId: toolCallId, name }],
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSubagentCompleted(
  state: TextGenerationStreamState,
  callId: string,
  summary: string,
  toolCallCount: number
) {
  const parts = updateSubagentTracePart(state.parts, callId, (part) => ({
    ...part,
    status: 'completed',
    summary,
    toolCallCount,
    lastMessage: summary,
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSubagentFailed(state: TextGenerationStreamState, callId: string, error: string) {
  const parts = updateSubagentTracePart(state.parts, callId, (part) => ({
    ...part,
    status: 'failed',
    summary: error,
    error,
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceMcpMedia(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'mcp_media' }>
) {
  const mediaPart: MessagePart = {
    type: 'mcp_media',
    toolCallId: chunk.toolCallId,
    serverSlug: chunk.serverSlug,
    toolName: chunk.toolName,
    kind: chunk.kind,
    mimeType: chunk.mimeType,
    url: chunk.url,
    ...(chunk.uri ? { uri: chunk.uri } : {}),
  };
  const exists = state.parts.some(
    (part) =>
      part.type === 'mcp_media' && part.toolCallId === chunk.toolCallId && part.url === chunk.url
  );
  const parts = exists ? state.parts : [...state.parts, mediaPart];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceQuestion(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'question' }>
) {
  const exists = state.parts.some(
    (part) => part.type === 'question' && part.toolCallId === chunk.toolCallId
  );
  const questionPart: MessagePart = {
    type: 'question',
    toolCallId: chunk.toolCallId,
    questions: chunk.questions,
  };
  const parts = exists ? state.parts : [...state.parts, questionPart];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceMcpElicitation(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'mcp_elicitation_request' }>
) {
  const exists = state.parts.some(
    (part) => part.type === 'mcp_elicitation' && part.elicitationId === chunk.elicitationId
  );
  const elicitationPart: MessagePart = {
    type: 'mcp_elicitation',
    elicitationId: chunk.elicitationId,
    toolCallId: chunk.toolCallId,
    serverSlug: chunk.serverSlug,
    message: chunk.message,
    fields: chunk.fields,
    status: chunk.status,
  };
  // A repeated request for a known id updates the existing part in place so a
  // status carried by the duplicate is never dropped.
  const parts = exists
    ? updateElicitationStatus(state.parts, chunk.elicitationId, chunk.status)
    : [...state.parts, elicitationPart];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceMcpElicitationStatus(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'mcp_elicitation_status' }>
) {
  const parts = updateElicitationStatus(
    state.parts,
    chunk.elicitationId,
    chunk.status,
    chunk.reason
  );
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function updateElicitationStatus(
  parts: MessagePart[],
  elicitationId: string,
  status: Extract<MessagePart, { type: 'mcp_elicitation' }>['status'],
  reason?: Extract<MessagePart, { type: 'mcp_elicitation' }>['reason']
): MessagePart[] {
  // The first terminal status wins; a late or duplicate event never moves it.
  return parts.map((part) =>
    part.type === 'mcp_elicitation' &&
    part.elicitationId === elicitationId &&
    part.status === 'pending' &&
    part.status !== status
      ? { ...part, status, ...(reason ? { reason } : {}) }
      : part
  );
}

function reduceTodoUpdate(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'todo_update' }>
) {
  const exists = state.parts.some(
    (part) => part.type === 'todo' && part.toolCallId === chunk.toolCallId
  );
  const todoPart: MessagePart = {
    type: 'todo',
    toolCallId: chunk.toolCallId,
    todos: chunk.todos,
  };
  const parts = exists ? state.parts : [...state.parts, todoPart];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceImageGenerationStarted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'image_generation_started' }>
) {
  const parts = upsertGeneratedImagePart(state.parts, {
    type: 'generated_image',
    imageId: chunk.imageId,
    toolCallId: chunk.toolCallId,
    status: 'generating',
    prompt: chunk.prompt,
  });
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceImageGenerationCompleted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'image_generation_completed' }>
) {
  const parts = upsertGeneratedImagePart(state.parts, {
    type: 'generated_image',
    imageId: chunk.imageId,
    toolCallId: chunk.toolCallId,
    status: 'completed',
    prompt: chunk.prompt,
    imageUrl: chunk.imageUrl,
    modelName: chunk.modelName,
    generationTime: chunk.generationTime,
  });
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceImageGenerationFailed(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'image_generation_failed' }>
) {
  const parts = upsertGeneratedImagePart(state.parts, {
    type: 'generated_image',
    imageId: chunk.imageId,
    toolCallId: chunk.toolCallId,
    status: 'error',
    prompt: chunk.prompt,
    error: chunk.error,
    modelName: chunk.modelName,
    generationTime: chunk.generationTime,
  });
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceContinuationTransition(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'continuation_transition' }>
) {
  const parts = [
    ...state.parts,
    {
      type: 'continuation_transition',
      provider: chunk.provider,
      modelName: chunk.modelName,
      fromProvider: chunk.fromProvider,
      fromMode: chunk.fromMode,
      toMode: chunk.toMode,
      reasonCode: chunk.reasonCode,
      detail: chunk.detail,
      recovered: false,
    } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceSystemEvent(
  state: TextGenerationStreamState,
  event: string,
  detail: string | undefined,
  pendingSubagentName: string
) {
  const subagentEvent = parseSubagentSystemEvent(event, detail);
  const parts = subagentEvent
    ? appendSubagentTraceEvent(state.parts, subagentEvent, pendingSubagentName)
    : [...state.parts, { type: 'system_event', event, detail } satisfies MessagePart];
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceDone(
  state: TextGenerationStreamState,
  messageId: string | undefined,
  generationTime: string | undefined
) {
  return withAiMessageUpdate(
    { ...state, activeThinkingIndex: null },
    {
      isGenerating: false,
      text: state.text,
      parts: [...state.parts],
      generationTime,
      ...(messageId ? { id: messageId } : {}),
    },
    messageId,
    messageId ? true : state.receivedServerAiMessageId
  );
}

/**
 * An external turn's own reduction, deliberately separate from the internal one.
 *
 * The hub builds the durable transcript from the same neutral events these
 * chunks were projected from, so every function below has an exact counterpart
 * in `ExternalTurnTranscript` and has to agree with it — including the parts
 * that look like details, such as appending a delta to the *trailing* part
 * rather than to the first `text` part found. `upsertTextPart` moves the text
 * block to the end, which is right for a MangoStudio turn whose prose is one
 * block, and wrong for a vendor that interleaves prose with its own activity.
 *
 * `apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts`
 * drives both paths from one event sequence and compares the results.
 */
function reduceExternalSessionStarted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_session_started' }>
) {
  if (state.parts.some((part) => part.type === 'external_turn')) return state;
  const parts = [
    ...state.parts,
    {
      type: 'external_turn',
      version: 1,
      targetId: chunk.targetId,
      sessionId: chunk.sessionId,
      status: 'active',
      // Server-owned bookkeeping. The live view has no honest value for any of
      // them — the hub counts what it persisted, not what it sent — and the
      // stored record replaces this part wholesale on the next read.
      startedAt: 0,
      updatedAt: 0,
      lastSequence: 0,
      eventCount: 0,
      persistedBytes: 0,
    } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceExternalText(state: TextGenerationStreamState, textDelta: string) {
  const text = `${state.text}${textDelta}`;
  const parts = appendExternalText(state.parts, 'text', textDelta);
  return withAiMessageUpdate({ ...state, text, parts, activeThinkingIndex: null }, { text, parts });
}

function reduceExternalReasoning(state: TextGenerationStreamState, textDelta: string) {
  const parts = appendExternalText(state.parts, 'thinking', textDelta);
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalActivityStarted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_activity_started' }>
) {
  const parts = [
    ...state.parts,
    {
      type: 'external_activity',
      targetId: externalTargetId(state.parts),
      callId: chunk.callId,
      name: chunk.name,
      kind: chunk.kind,
      title: chunk.title,
      ...(chunk.detail !== undefined ? { detail: chunk.detail } : {}),
      status: 'running',
      ...(chunk.truncated ? { truncated: true } : {}),
    } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceExternalActivityUpdated(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_activity_updated' }>
) {
  const parts = updateExternalActivity(state.parts, chunk.callId, (part) => ({
    ...part,
    ...(chunk.update.title !== undefined ? { title: chunk.update.title } : {}),
    ...(chunk.update.detail !== undefined ? { detail: chunk.update.detail } : {}),
    ...(chunk.update.truncated ? { truncated: true } : {}),
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalActivityCompleted(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_activity_completed' }>
) {
  const parts = updateExternalActivity(state.parts, chunk.callId, (part) => ({
    ...part,
    status: chunk.status,
    ...(chunk.detail !== undefined ? { detail: chunk.detail } : {}),
    ...(chunk.isError ? { isError: true } : {}),
    ...(chunk.truncated ? { truncated: true } : {}),
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalApprovalRequest(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_approval_request' }>
) {
  const exists = state.parts.some(
    (part) => part.type === 'external_approval' && part.requestId === chunk.requestId
  );
  if (exists) return state;
  const parts = [
    ...state.parts,
    {
      type: 'external_approval',
      targetId: externalTargetId(state.parts),
      requestId: chunk.requestId,
      kind: chunk.kind,
      title: chunk.title,
      ...(chunk.detail !== undefined ? { detail: chunk.detail } : {}),
      // The vendor's option set, in the vendor's order, untouched.
      options: chunk.options,
      expiresAtMs: chunk.expiresAtMs,
      ...(chunk.truncated ? { truncated: true } : {}),
    } satisfies MessagePart,
  ];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceExternalApprovalStatus(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_approval_status' }>
) {
  // The first resolution wins, exactly as it does on the transcript: a late echo
  // must not rewrite a decision that is already recorded.
  const parts = state.parts.map((part) =>
    part.type === 'external_approval' &&
    part.requestId === chunk.requestId &&
    part.decisionSource === undefined
      ? {
          ...part,
          decision: chunk.decision.optionId,
          decisionSource: chunk.decision.source,
        }
      : part
  );
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalUsage(state: TextGenerationStreamState, usage: ExternalUsage) {
  // Sparse by design: a later report that omits a field must not erase it.
  const parts = updateExternalTurn(state.parts, (part) => ({
    ...part,
    usage: { ...part.usage, ...usage },
  }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalThreadUsage(state: TextGenerationStreamState, usage: ExternalThreadUsage) {
  // Scopes stay separate: never fold thread totals into the per-turn part.
  return {
    ...state,
    threadUsage: {
      last:
        usage.last !== undefined
          ? { ...state.threadUsage?.last, ...usage.last }
          : state.threadUsage?.last,
      total:
        usage.total !== undefined
          ? { ...state.threadUsage?.total, ...usage.total }
          : state.threadUsage?.total,
    },
  };
}

function reduceExternalSteer(
  state: TextGenerationStreamState,
  chunk: Extract<StreamChunk, { type: 'external_steer' }>
) {
  // One chunk per attempt, arriving resolved — see `ExternalTurnTranscript`'s
  // steer methods, which write the same part twice server-side but never
  // notify until the outcome is known. Appending is therefore correct on the
  // first delivery, and idempotent against a duplicate: a `clientMessageId`
  // this state has already rendered is a no-op rather than a second row.
  if (
    state.parts.some(
      (part) => part.type === 'external_steer' && part.clientMessageId === chunk.clientMessageId
    )
  ) {
    return state;
  }
  const steerPart =
    chunk.status === 'rejected'
      ? {
          type: 'external_steer' as const,
          targetId: externalTargetId(state.parts),
          clientMessageId: chunk.clientMessageId,
          text: chunk.text,
          status: 'rejected' as const,
          reasonCode: chunk.reasonCode,
          createdAt: 0,
        }
      : {
          type: 'external_steer' as const,
          targetId: externalTargetId(state.parts),
          clientMessageId: chunk.clientMessageId,
          text: chunk.text,
          status: 'accepted' as const,
          createdAt: 0,
        };
  const parts = [...state.parts, steerPart satisfies MessagePart];
  return withAiMessageUpdate({ ...state, parts, activeThinkingIndex: null }, { parts });
}

function reduceExternalError(state: TextGenerationStreamState, error: ExternalAgentError) {
  const parts = updateExternalTurn(state.parts, (part) => ({ ...part, error }));
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

function reduceExternalTurnCompleted(
  state: TextGenerationStreamState,
  reason: ExternalTurnTerminalReason
) {
  const parts = updateExternalTurn(state.parts, (part) =>
    part.status === 'terminal' ? part : { ...part, status: 'terminal', terminalReason: reason }
  );
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

/**
 * Which vendor produced this turn.
 *
 * Read off the turn part rather than carried on every chunk: the session chunk
 * always precedes vendor output, and repeating the target on each event would
 * be a second place for it to be wrong. `codex` is a last resort that only a
 * malformed stream can reach.
 */
function externalTargetId(parts: readonly MessagePart[]): ExternalAgentTargetId {
  const turn = parts.find((part) => part.type === 'external_turn');
  return turn?.type === 'external_turn' ? turn.targetId : 'codex';
}

function updateExternalTurn(
  parts: MessagePart[],
  update: (current: ExternalTurnPart) => ExternalTurnPart
): MessagePart[] {
  return parts.map((part) => (part.type === 'external_turn' ? update(part) : part));
}

function updateExternalActivity(
  parts: MessagePart[],
  callId: string,
  update: (current: ExternalActivityPart) => ExternalActivityPart
): MessagePart[] {
  return parts.map((part) =>
    part.type === 'external_activity' && part.callId === callId ? update(part) : part
  );
}

/**
 * Appends to the trailing part when it is already of this kind.
 *
 * A stream of deltas becomes one block, and interleaved activity still splits
 * the prose where the vendor split it — which is what the persisted transcript
 * records, so it is what a live render has to produce.
 */
function appendExternalText(
  parts: MessagePart[],
  kind: 'text' | 'thinking',
  text: string
): MessagePart[] {
  const last = parts.at(-1);
  if (last?.type === kind) {
    return [...parts.slice(0, -1), { ...last, text: `${last.text}${text}` }];
  }
  return [...parts, kind === 'text' ? { type: 'text', text } : { type: 'thinking', text }];
}

function withUserMessageUpdate(
  state: TextGenerationStreamState,
  patch: Partial<Message>,
  nextMessageId = state.currentUserMessageId,
  receivedServerUserMessageId = state.receivedServerUserMessageId
): TextGenerationStreamState {
  return {
    ...state,
    currentUserMessageId: nextMessageId,
    receivedServerUserMessageId,
    userMessageUpdate: { targetMessageId: state.currentUserMessageId, patch },
  };
}

function withAiMessageUpdate(
  state: TextGenerationStreamState,
  patch: Partial<Message>,
  nextMessageId = state.currentAiMessageId,
  receivedServerAiMessageId = state.receivedServerAiMessageId
): TextGenerationStreamState {
  return {
    ...state,
    currentAiMessageId: nextMessageId,
    receivedServerAiMessageId,
    aiMessageUpdate: { targetMessageId: state.currentAiMessageId, patch },
  };
}

function replacePartAt(parts: MessagePart[], index: number, nextPart: MessagePart): MessagePart[] {
  return parts.map((part, partIndex) => (partIndex === index ? nextPart : part));
}

function upsertTextPart(parts: MessagePart[], text: string): MessagePart[] {
  const textIndex = parts.findIndex((part) => part.type === 'text');
  if (textIndex === -1) return [...parts, { type: 'text', text }];
  const nextParts = [...parts.slice(0, textIndex), ...parts.slice(textIndex + 1)];
  return [...nextParts, { type: 'text', text }];
}

function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    return JSON.parse(argumentsText) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function upsertGeneratedImagePart(parts: MessagePart[], generatedImagePart: GeneratedImagePart) {
  const existingIndex = parts.findIndex(
    (part) =>
      part.type === 'generated_image' &&
      part.imageId === generatedImagePart.imageId &&
      part.toolCallId === generatedImagePart.toolCallId
  );
  if (existingIndex === -1) return [...parts, generatedImagePart];
  return replacePartAt(parts, existingIndex, generatedImagePart);
}

function upsertSubagentTracePart(
  parts: MessagePart[],
  tracePart: Extract<MessagePart, { type: 'subagent_trace' }>
) {
  const existingIndex = parts.findIndex(
    (part) => part.type === 'subagent_trace' && part.toolCallId === tracePart.toolCallId
  );
  if (existingIndex === -1) return [...parts, tracePart];
  return parts.map((part, index) => {
    if (index !== existingIndex || part.type !== 'subagent_trace') return part;
    return {
      ...tracePart,
      messages: tracePart.messages.length > 0 ? tracePart.messages : part.messages,
      tools: tracePart.tools.length > 0 ? tracePart.tools : part.tools,
      events: mergeSubagentTraceEvents(part.events, tracePart.events),
    };
  });
}

function updateSubagentTracePart(
  parts: MessagePart[],
  toolCallId: string,
  update: (
    current: Extract<MessagePart, { type: 'subagent_trace' }>
  ) => Extract<MessagePart, { type: 'subagent_trace' }>
) {
  return parts.map((part) => {
    if (part.type !== 'subagent_trace' || part.toolCallId !== toolCallId) return part;
    return update(part);
  });
}

function appendSubagentTraceEvent(
  parts: MessagePart[],
  event: ParsedSubagentEvent,
  pendingSubagentName: string
) {
  const existingIndex = parts.findIndex(
    (part) => part.type === 'subagent_trace' && part.toolCallId === event.callId
  );
  const traceEvent: SubagentTraceEvent = {
    event: event.event,
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.detail ? { detail: event.detail } : {}),
  };

  if (existingIndex === -1) {
    return [
      ...parts,
      {
        type: 'subagent_trace',
        toolCallId: event.callId,
        agentId: event.agentId ?? event.callId,
        agentName: event.agentId ?? pendingSubagentName,
        status: 'running',
        summary: '',
        toolCallCount: 0,
        messages: [],
        tools: [],
        events: [traceEvent],
      } satisfies MessagePart,
    ];
  }

  return parts.map((part, index) => {
    if (index !== existingIndex || part.type !== 'subagent_trace') return part;
    const agentName =
      part.agentName === pendingSubagentName && event.agentId ? event.agentId : part.agentName;
    return {
      ...part,
      agentId: event.agentId ?? part.agentId,
      agentName,
      events: mergeSubagentTraceEvents(part.events, [traceEvent]),
    };
  });
}

function parseSubagentSystemEvent(
  event: string,
  detail: string | undefined
): ParsedSubagentEvent | null {
  const lifecycleEvent = SUBAGENT_SYSTEM_EVENTS[event];
  if (!lifecycleEvent) return null;
  const callId = readDetailField(detail, 'call');
  if (!callId) return null;
  const attemptText = readDetailField(detail, 'attempt');
  const attempt = attemptText ? Number(attemptText) : undefined;
  const agentId = readDetailField(detail, 'agent') ?? readDetailField(detail, 'target');
  return {
    callId,
    event: lifecycleEvent,
    ...(agentId ? { agentId } : {}),
    ...(attempt !== undefined && Number.isFinite(attempt) ? { attempt } : {}),
    ...(detail ? { detail } : {}),
  };
}

function readDetailField(detail: string | undefined, field: string) {
  const match = detail?.match(new RegExp(`(?:^|\\s)${field}=([^\\s]+)`));
  return match?.[1];
}
