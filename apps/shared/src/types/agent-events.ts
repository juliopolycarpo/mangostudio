import type {
  ExternalActivityKind,
  ExternalActivityStatus,
  ExternalAgentError,
  ExternalAgentTargetId,
  ExternalApprovalOption,
  ExternalTurnTerminalReason,
  ExternalUsage,
} from '../external-agents/schemas';
import type { McpElicitationPart } from '../mcp/schemas';
import type { QuestionSpec } from '../questions/schemas';
import type { TodoItem } from '../todos/schemas';
import type { ToolExecutionSnapshot } from '../tool-executions/schemas';
import type { TurnCheckpointPart } from '../turn-recovery/schemas';
import type { ProviderType } from './provider';

export type { McpElicitationPart } from '../mcp/schemas';

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

interface SubagentTraceMessage {
  role: 'assistant' | 'system';
  text: string;
}

interface SubagentToolTrace {
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

/**
 * Something a vendor CLI did during an external turn, as something to render.
 *
 * Deliberately **not** `tool_call` / `tool_result` with an owner flag.
 * `resolveToolCallStatus`, the re-run affordances, tool budget accounting and
 * the executor all key off `tool_call`; a separate type is what keeps every one
 * of those paths from ever seeing external activity. `name` is the vendor's own
 * tool name, verbatim — it is bounded and stripped at the runtime boundary and
 * rendered as plain text, never markdown or HTML.
 */
export interface ExternalActivityPart {
  type: 'external_activity';
  targetId: ExternalAgentTargetId;
  callId: string;
  name: string;
  kind: ExternalActivityKind;
  title: string;
  detail?: string;
  status: 'running' | ExternalActivityStatus;
  isError?: boolean;
  /** True when any vendor string above was cut to fit its bound. */
  truncated?: boolean;
}

/**
 * One approval the vendor asked for, and what became of it.
 *
 * The option set is the vendor's, in the vendor's order, and it is persisted so
 * that a reloaded transcript can render a resolved card without asking the
 * vendor again. An approval still pending when its turn ends carries
 * `decisionSource: 'expired'` and no `decision`: nobody chose an option, and
 * inventing one would put a decision in the transcript that no user made. A
 * dead card is honest; a live control that will never resolve is not.
 */
export interface ExternalApprovalPart {
  type: 'external_approval';
  targetId: ExternalAgentTargetId;
  requestId: string;
  kind: ExternalActivityKind;
  title: string;
  detail?: string;
  options: readonly ExternalApprovalOption[];
  expiresAtMs: number;
  /** The option that was chosen. Absent while pending, and when nobody chose one. */
  decision?: string;
  /** How the approval left the pending set. Absent only while it is still pending. */
  decisionSource?: 'user' | 'auto-review' | 'expired' | 'cancelled';
  resolvedAt?: number;
  truncated?: boolean;
}

/**
 * The durable record of one external turn, and the external analogue of
 * `turn_checkpoint`.
 *
 * It cannot reuse `turn_checkpoint`: that part carries a MangoStudio provider,
 * model and agent id, none of which an external turn has, and its
 * `completedCalls` / `incompleteCalls` describe MangoStudio's own tool loop.
 * What an external turn needs recorded instead is which session and native turn
 * produced the transcript, how far the ordered stream got, and why it stopped.
 *
 * It is also the message-level marker a renderer keys off. Every `text` and
 * `thinking` part in a message carrying this one was written by the vendor, not
 * by MangoStudio, and vendor text is rendered as **plain text, never markdown or
 * HTML** — see `docs/architecture/external-agents.md`. A renderer that treats
 * such a message like any other assistant message would interpret vendor-
 * controlled markup as links, images and formatting.
 */
export interface ExternalTurnPart {
  type: 'external_turn';
  version: 1;
  targetId: ExternalAgentTargetId;
  /** Hub-minted session id; the vendor's own handle stays server-side. */
  sessionId: string;
  nativeTurnId?: string;
  status: 'active' | 'terminal';
  /** Present once `status` is `terminal`. */
  terminalReason?: ExternalTurnTerminalReason;
  startedAt: number;
  updatedAt: number;
  /** Highest envelope sequence applied to this turn; a cursor, not a count. */
  lastSequence: number;
  eventCount: number;
  persistedBytes: number;
  /** Accumulated as it arrives: the vendor reports usage before it reports completion. */
  usage?: ExternalUsage;
  error?: ExternalAgentError;
}

/** Discriminated union of all content block types in an assistant message. */
export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string; redacted?: boolean }
  | {
      type: 'tool_call';
      toolCallId: string;
      name: string;
      args: Record<string, unknown>;
      /**
       * Lifecycle snapshot written by the execution owner. Absent on parts
       * persisted before the unified lifecycle existed and on provider-internal
       * tool loops; readers normalize those via `resolveToolCallStatus`.
       */
      execution?: ToolExecutionSnapshot;
    }
  | { type: 'tool_result'; toolCallId: string; content: string; isError?: boolean }
  | GeneratedImagePart
  | McpMediaPart
  | QuestionPart
  | McpElicitationPart
  | TodoPart
  | SubagentTracePart
  | TurnCheckpointPart
  | ExternalActivityPart
  | ExternalApprovalPart
  | ExternalTurnPart
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
