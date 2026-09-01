import type { GeneratedImagePart, Message, MessagePart } from '@mangostudio/shared';
import type {
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
  /**
   * Where in `parts` the reasoning phase an external turn opened sits, until
   * `external_reasoning_ended` closes it.
   *
   * Mirrors `ExternalTurnTranscript`'s `#openThinking`, by index rather than
   * by reference because this state is rebuilt on every chunk. The vendor's
   * own statement of where the turn is — see `reduceExternalTurnCompleted`.
   */
  readonly openExternalThinkingIndex: number | null;
  readonly userMessageUpdate: TextGenerationStreamMessageUpdate | null;
  readonly aiMessageUpdate: TextGenerationStreamMessageUpdate | null;
  /** Cumulative thread usage from the vendor — separate from per-turn `usage` on the turn part. */
  readonly threadUsage: ExternalThreadUsage | null;
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
    openExternalThinkingIndex: null,
    userMessageUpdate: null,
    aiMessageUpdate: null,
    threadUsage: null,
  };
}

/**
 * Settles every `generated_image` part still at `generating` onto `error`.
 *
 * A card only moves off `generating` when its `image_generation_completed` or
 * `image_generation_failed` event arrives, so any stream that ends before those
 * are read — a torn-down reader, a dropped socket, a provider that threw —
 * leaves it pulsing with nothing left to settle it. Returns `parts` unchanged
 * when none is pending, so a caller can tell "nothing to write" from "wrote the
 * same array".
 *
 * Usage: `const parts = settleUnfinishedImageParts(state.parts, t.errors.imageGenerationInterrupted)`
 */
export function settleUnfinishedImageParts(parts: MessagePart[], error: string): MessagePart[] {
  if (!parts.some(isUnfinishedImagePart)) return parts;
  return parts.map((part) =>
    isUnfinishedImagePart(part) ? { ...part, status: 'error' as const, error } : part
  );
}

function isUnfinishedImagePart(part: MessagePart): part is GeneratedImagePart {
  return part.type === 'generated_image' && part.status === 'generating';
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
    case 'external_reasoning_started':
      // Opens the same empty trailing `thinking` part a `thinking_start`
      // chunk opens for an internal turn — `display: "omitted"` is the API
      // default on current models, so this is often the only signal a whole
      // reasoning phase produces.
      return reduceExternalReasoningStarted(nextState);
    case 'external_reasoning_ended':
      return reduceExternalReasoningEnded(nextState);
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
    case 'external_steer':
      return reduceExternalSteer(nextState, chunk);
    case 'external_error':
      return reduceExternalError(nextState, chunk.error);
    case 'external_turn_completed':
      return reduceExternalTurnCompleted(nextState, chunk.reason);
    case 'done':
      return reduceDone(nextState, chunk.messageId, chunk.generationTime);
    // Handled by the caller, not by the transcript: an account quota belongs to
    // the machine's signed-in account, not to this turn's messages, and the send
    // path files it in the shared query cache the quota surfaces read. A slash
    // command catalog is filed the same way, for the same reason — it says what
    // the user may type next, which is a property of the session rather than of
    // any message in it.
    case 'external_account_limits':
    case 'external_commands':
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
  // `state.text` still accumulates every delta for the legacy `msg.text` patch;
  // the parts array gets the delta alone, appended to the trailing text part.
  const text = `${state.text}${textDelta}`;
  const parts = appendTrailingText(state.parts, 'text', textDelta);
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
 * in `ExternalTurnTranscript` and has to agree with it.
 *
 * `apps/frontend/tests/unit/features/generation/external-turn-live-vs-reload.test.ts`
 * drives both paths from one event sequence and compares the results, and
 * `internal-turn-live-vs-reload.test.ts` does the same for the internal one.
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
  const parts = appendTrailingText(state.parts, 'text', textDelta);
  return withAiMessageUpdate({ ...state, text, parts, activeThinkingIndex: null }, { text, parts });
}

function reduceExternalReasoning(state: TextGenerationStreamState, textDelta: string) {
  const parts = appendTrailingText(state.parts, 'thinking', textDelta);
  return withAiMessageUpdate({ ...state, parts }, { parts });
}

/**
 * Opens the reasoning phase and remembers where it sits.
 *
 * A phase still open when the next one starts was displaced by output the
 * vendor produced in between and never closed in word — what a runtime too old
 * to send `external_reasoning_ended` always produces. Closing it first discards
 * it when it is empty, instead of stranding a blank block mid-transcript.
 * `appendTrailingText` then coalesces onto a trailing `thinking` part, so a
 * phase that already received text is not opened a second time.
 */
function reduceExternalReasoningStarted(state: TextGenerationStreamState) {
  const closed = closeThinkingAt(state.parts, state.openExternalThinkingIndex);
  const parts = appendTrailingText(closed.parts, 'thinking', '');
  return withAiMessageUpdate(
    { ...state, parts, openExternalThinkingIndex: parts.length - 1 },
    { parts }
  );
}

/**
 * Closes the reasoning phase the vendor just ended.
 *
 * Mirrors `ExternalTurnTranscript`'s `reasoning_ended`: a phase that closes
 * with nothing in it was withheld rather than still running, so it is dropped
 * at the moment that becomes knowable rather than by a rule about which part
 * happens to be last.
 */
function reduceExternalReasoningEnded(state: TextGenerationStreamState) {
  const { parts } = closeThinkingAt(state.parts, state.openExternalThinkingIndex);
  return withAiMessageUpdate({ ...state, parts, openExternalThinkingIndex: null }, { parts });
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
      // Sparse like the rest: the window is a property of the model, not of
      // this report, so a later report that omits it must not blank the ring.
      contextWindowTokens: usage.contextWindowTokens ?? state.threadUsage?.contextWindowTokens,
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
  // Mirrors `ExternalTurnTranscript.finalize` exactly. A reasoning phase the
  // vendor never closed is where the turn stopped, so it is the part that
  // carries the marker; an empty one is dropped and marks nothing, because
  // there is no text to have been cut off. With no phase open the turn stopped
  // in whatever is trailing, which is the case that predates this rule.
  const closed = closeThinkingAt(state.parts, state.openExternalThinkingIndex);
  const marked =
    reason === 'completed' ? closed.parts : markIncompleteAt(closed.parts, closed.stoppedInside);
  const parts = updateExternalTurn(marked, (part) =>
    part.status === 'terminal' ? part : { ...part, status: 'terminal', terminalReason: reason }
  );
  return withAiMessageUpdate({ ...state, parts, openExternalThinkingIndex: null }, { parts });
}

/**
 * Closes the open reasoning phase, and says which part the turn stopped inside.
 *
 * Mirrors `ExternalTurnTranscript#closeThinking` exactly, so a live render and
 * a reload never disagree. An empty phase is dropped — the common case on a
 * model whose API default withholds `thinking_delta` text, and one that would
 * otherwise survive as a permanently blank collapsed block — and nothing is
 * left to mark. A phase with text is where the turn stopped. With no phase
 * open at all, the turn stopped in whatever is trailing.
 *
 * Usage: `closeThinkingAt(parts, state.openExternalThinkingIndex)`
 */
function closeThinkingAt(
  parts: MessagePart[],
  open: number | null
): { readonly parts: MessagePart[]; readonly stoppedInside: number } {
  if (open === null) return { parts, stoppedInside: parts.length - 1 };
  const phase = parts[open];
  if (phase?.type !== 'thinking') return { parts, stoppedInside: parts.length - 1 };
  // Displaced by output the vendor produced after it — closed in fact if not
  // in word, which is what a runtime too old to send `reasoning_ended` always
  // produces. An empty one still goes; the marker belongs on the trailing part.
  const displaced = open !== parts.length - 1;
  if (phase.text.length > 0) return { parts, stoppedInside: displaced ? parts.length - 1 : open };
  const kept = [...parts.slice(0, open), ...parts.slice(open + 1)];
  return { parts: kept, stoppedInside: displaced ? kept.length - 1 : -1 };
}

/**
 * Marks one part as cut short. No vendor event describes a sentence stopping
 * mid-word, so the part the turn was inside when it stopped is the closest
 * true statement available. An index of -1 marks nothing.
 */
function markIncompleteAt(parts: MessagePart[], index: number): MessagePart[] {
  const part = parts[index];
  if (!part || (part.type !== 'text' && part.type !== 'thinking')) return parts;
  const marked: MessagePart = { ...part, incomplete: true };
  return [...parts.slice(0, index), marked, ...parts.slice(index + 1)];
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
 * the prose where the producer split it — which is what the persisted
 * transcript records, so it is what a live render has to produce. True of a
 * vendor CLI and of MangoStudio's own harness alike: prose written before a
 * tool call belongs before it, and the previous rule — remove the text part,
 * re-append it with the whole accumulated text — moved it after.
 */
function appendTrailingText(
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
