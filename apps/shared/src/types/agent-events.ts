import type { QuestionSpec } from '../questions/schemas';
import type { TodoItem } from '../todos/schemas';
import type { ProviderType } from './provider';

/**
 * Normalized reason for a continuation degradation event.
 * Used in both persisted MessageParts and live SSE events.
 */
export type ContinuationReasonCode =
  | 'provider_changed'
  | 'model_changed'
  | 'system_prompt_changed'
  | 'toolset_changed'
  | 'agent_changed'
  | 'agent_runtime_changed'
  | 'cursor_expired'
  | 'cursor_invalid'
  | 'tool_result_cursor_loss'
  | 'envelope_malformed';

/** A single event emitted during an agentic turn (streaming tool loop). */
export type AgentEvent =
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call_started'; callId: string; name?: string }
  | { type: 'tool_call_arguments_delta'; callId: string; delta: string }
  | { type: 'tool_call_completed'; callId: string; name: string; arguments: string }
  | { type: 'tool_result'; callId: string; name: string; result: unknown; isError?: boolean }
  | { type: 'assistant_text_delta'; text: string }
  | { type: 'turn_completed'; providerState?: string; finishReason?: string }
  | { type: 'turn_error'; error: string }
  | {
      type: 'continuation_degraded';
      from: string;
      to: string;
      reason: string;
      reasonCode: ContinuationReasonCode;
    };

export type GeneratedImageStatus = 'generating' | 'completed' | 'error';

export interface GeneratedImagePart {
  type: 'generated_image';
  imageId: string;
  toolCallId: string;
  status: GeneratedImageStatus;
  prompt: string;
  imageUrl?: string;
  error?: string;
  modelName?: string;
  generationTime?: string;
}

/**
 * Rich media produced by an MCP tool call: an image content block persisted
 * to image storage, or a binary embedded resource persisted as a chat
 * attachment. Provenance is carried by (serverSlug, toolName, toolCallId).
 */
export interface McpMediaPart {
  type: 'mcp_media';
  toolCallId: string;
  serverSlug: string;
  toolName: string;
  kind: 'image' | 'resource';
  mimeType: string;
  /** URL of the persisted content (`/images/...` or `/uploads/...`). */
  url: string;
  /** Source URI when the block was an embedded resource. */
  uri?: string;
}

/**
 * Structured questions an `ask_user_question` tool call presented to the user.
 * The answer arrives as the next user message; the frontend renders the card
 * interactively only while this part belongs to the last message of the chat.
 */
export interface QuestionPart {
  type: 'question';
  toolCallId: string;
  questions: QuestionSpec[];
}

/**
 * Snapshot of the chat todo list a `todo_write` call produced, rendered as an
 * inline checklist in the chat feed. Full-replace semantics: each part carries
 * the entire list as of that write.
 */
export interface TodoPart {
  type: 'todo';
  toolCallId: string;
  todos: TodoItem[];
}

export interface SubagentTraceMessage {
  role: 'assistant' | 'system';
  text: string;
}

export interface SubagentToolTrace {
  callId: string;
  name: string;
  isError?: boolean;
}

export type SubagentTraceEventName =
  | 'delegation_started'
  | 'delegation_completed'
  | 'delegation_failed'
  | 'response_attempt'
  | 'response_recovered'
  | 'response_timeout'
  | 'response_fallback';

export interface SubagentTraceEvent {
  event: SubagentTraceEventName;
  attempt?: number;
  detail?: string;
}

/**
 * Merges two trace event lists, de-duping by (event, attempt, detail).
 * Used by both the API turn runner (cumulative trace per attempt) and the
 * frontend stream consumer (incoming SSE events appended to optimistic state).
 */
export function mergeSubagentTraceEvents(
  current: ReadonlyArray<SubagentTraceEvent> | undefined,
  next: ReadonlyArray<SubagentTraceEvent> | undefined
): ReadonlyArray<SubagentTraceEvent> | undefined {
  if (!current?.length) return next;
  if (!next?.length) return current;
  const merged = [...current];
  for (const event of next) {
    const exists = merged.some(
      (item) =>
        item.event === event.event && item.attempt === event.attempt && item.detail === event.detail
    );
    if (!exists) merged.push(event);
  }
  return merged;
}

export interface SubagentTracePart {
  type: 'subagent_trace';
  toolCallId: string;
  agentId: string;
  agentName: string;
  status: 'running' | 'completed' | 'failed' | 'aborted' | 'timeout';
  summary: string;
  toolCallCount: number;
  lastMessage?: string;
  messages: ReadonlyArray<SubagentTraceMessage>;
  tools: ReadonlyArray<SubagentToolTrace>;
  events?: ReadonlyArray<SubagentTraceEvent>;
  error?: string;
}

/** Discriminated union of all content block types in an assistant message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | { type: 'tool_call'; toolCallId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | GeneratedImagePart
  | McpMediaPart
  | QuestionPart
  | TodoPart
  | SubagentTracePart
  | { type: 'error'; text: string }
  | { type: 'system_event'; event: string; detail?: string }
  | {
      type: 'continuation_transition';
      provider: ProviderType;
      modelName: string;
      fromProvider?: ProviderType;
      fromMode: string;
      toMode: string;
      reasonCode: ContinuationReasonCode;
      detail?: string;
      recovered: boolean;
    };
