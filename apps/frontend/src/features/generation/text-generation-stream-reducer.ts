import type { GeneratedImagePart, Message, MessagePart } from '@mangostudio/shared';
import type { StreamChunk } from '@mangostudio/shared/streaming';
import type { SubagentTraceEvent, SubagentTraceEventName } from '@mangostudio/shared/types';
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
