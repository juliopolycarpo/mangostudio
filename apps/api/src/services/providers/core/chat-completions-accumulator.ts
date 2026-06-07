import type { AgentEvent } from '../types';

interface ChatCompletionsToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatCompletionsDelta extends Record<string, unknown> {
  content?: string | null;
  tool_calls?: ChatCompletionsToolCallDelta[];
}

interface PendingToolCall {
  callId: string;
  name: string;
  argsStr: string;
  completionEmitted: boolean;
}

interface ChatCompletionsAccumulatorOptions {
  extractReasoningChunks(delta: Record<string, unknown>): string[];
}

export interface ChatCompletionsAccumulator {
  addDelta(delta: ChatCompletionsDelta): AgentEvent[];
  finishToolCalls(): AgentEvent[];
  buildAssistantMessage(): Record<string, unknown>;
}

/** Builds canonical AgentEvent deltas from Chat Completions stream chunks. */
// Usage: const accumulator = createChatCompletionsAccumulator({ extractReasoningChunks });
export function createChatCompletionsAccumulator(
  options: ChatCompletionsAccumulatorOptions
): ChatCompletionsAccumulator {
  let assistantText = '';
  let assistantReasoning = '';
  const pendingToolCalls = new Map<number, PendingToolCall>();

  return {
    addDelta(delta) {
      return [
        ...addReasoningDelta(delta, options, (chunk) => {
          assistantReasoning += chunk;
        }),
        ...addAssistantTextDelta(delta, (chunk) => {
          assistantText += chunk;
        }),
        ...addToolCallDelta(delta, pendingToolCalls),
      ];
    },
    finishToolCalls() {
      return completeToolCalls(pendingToolCalls);
    },
    buildAssistantMessage() {
      return buildAssistantMessage(assistantText, assistantReasoning, pendingToolCalls);
    },
  };
}

function addReasoningDelta(
  delta: Record<string, unknown>,
  options: ChatCompletionsAccumulatorOptions,
  onChunk: (chunk: string) => void
): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const chunk of options.extractReasoningChunks(delta)) {
    onChunk(chunk);
    events.push({ type: 'reasoning_delta', text: chunk });
  }
  return events;
}

function addAssistantTextDelta(
  delta: ChatCompletionsDelta,
  onChunk: (chunk: string) => void
): AgentEvent[] {
  if (typeof delta.content !== 'string' || !delta.content) return [];
  onChunk(delta.content);
  return [{ type: 'assistant_text_delta', text: delta.content }];
}

function addToolCallDelta(
  delta: ChatCompletionsDelta,
  pendingToolCalls: Map<number, PendingToolCall>
): AgentEvent[] {
  if (!Array.isArray(delta.tool_calls)) return [];
  return delta.tool_calls.flatMap((toolCallDelta) =>
    addSingleToolCallDelta(toolCallDelta, pendingToolCalls)
  );
}

function addSingleToolCallDelta(
  toolCallDelta: ChatCompletionsToolCallDelta,
  pendingToolCalls: Map<number, PendingToolCall>
): AgentEvent[] {
  const idx = typeof toolCallDelta.index === 'number' ? toolCallDelta.index : 0;
  const argsDelta = readToolArguments(toolCallDelta.function);

  if (typeof toolCallDelta.id === 'string') {
    const toolCall: PendingToolCall = {
      callId: toolCallDelta.id,
      name: readToolName(toolCallDelta.function),
      argsStr: argsDelta,
      completionEmitted: false,
    };
    pendingToolCalls.set(idx, toolCall);
    return createStartedEvents(toolCall, argsDelta);
  }

  const toolCall = pendingToolCalls.get(idx);
  if (!toolCall) return [];

  const nextName = readToolName(toolCallDelta.function);
  if (nextName) toolCall.name = nextName;
  if (!argsDelta) return [];

  toolCall.argsStr += argsDelta;
  return [{ type: 'tool_call_arguments_delta', callId: toolCall.callId, delta: argsDelta }];
}

function createStartedEvents(toolCall: PendingToolCall, argsDelta: string): AgentEvent[] {
  const events: AgentEvent[] = [
    { type: 'tool_call_started', callId: toolCall.callId, name: toolCall.name || undefined },
  ];
  if (argsDelta) {
    events.push({ type: 'tool_call_arguments_delta', callId: toolCall.callId, delta: argsDelta });
  }
  return events;
}

function completeToolCalls(pendingToolCalls: Map<number, PendingToolCall>): AgentEvent[] {
  const events: AgentEvent[] = [];
  for (const toolCall of getOrderedToolCalls(pendingToolCalls)) {
    if (toolCall.completionEmitted) continue;
    toolCall.completionEmitted = true;
    events.push({
      type: 'tool_call_completed',
      callId: toolCall.callId,
      name: toolCall.name,
      arguments: toolCall.argsStr,
    });
  }
  return events;
}

function buildAssistantMessage(
  assistantText: string,
  assistantReasoning: string,
  pendingToolCalls: Map<number, PendingToolCall>
): Record<string, unknown> {
  const toolCalls = getOrderedToolCalls(pendingToolCalls);
  if (toolCalls.length === 0) {
    return { role: 'assistant', content: assistantText };
  }

  return {
    role: 'assistant',
    content: assistantText || null,
    tool_calls: toolCalls.map((toolCall) => ({
      id: toolCall.callId,
      type: 'function',
      function: { name: toolCall.name, arguments: toolCall.argsStr },
    })),
    ...(assistantReasoning ? { reasoning_content: assistantReasoning } : {}),
  };
}

function getOrderedToolCalls(pendingToolCalls: Map<number, PendingToolCall>): PendingToolCall[] {
  return Array.from(pendingToolCalls.entries())
    .sort(([left], [right]) => left - right)
    .map(([, toolCall]) => toolCall);
}

function readToolName(fn: ChatCompletionsToolCallDelta['function']): string {
  return typeof fn?.name === 'string' ? fn.name : '';
}

function readToolArguments(fn: ChatCompletionsToolCallDelta['function']): string {
  return typeof fn?.arguments === 'string' ? fn.arguments : '';
}
