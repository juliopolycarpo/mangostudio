import Type, { type Static } from 'typebox';
import { SSEErrorEventSchema } from '../errors';
import {
  EXTERNAL_COMMAND_CATALOG_MAX_ITEMS,
  ExternalAccountLimitsSchema,
  ExternalActivityKindSchema,
  ExternalActivityStatusSchema,
  ExternalActivityUpdateSchema,
  ExternalAgentCommandSchema,
  ExternalAgentErrorSchema,
  ExternalAgentTargetIdSchema,
  ExternalApprovalDecisionSchema,
  ExternalApprovalOptionSchema,
  ExternalSteerRejectionReasonSchema,
  ExternalThreadUsageSchema,
  ExternalTurnTerminalReasonSchema,
  ExternalUsageSchema,
} from '../external-agents/schemas';
import { ImageGenerationErrorCodeSchema } from '../generation/schemas';
import {
  McpElicitationFieldSchema,
  McpElicitationStatusSchema,
  McpElicitationTerminalReasonSchema,
  McpElicitationTerminalStatusSchema,
} from '../mcp/schemas';
import { ProviderTypeSchema } from '../provider-settings/schemas';
import { QuestionSpecSchema } from '../questions/schemas';
import { TODO_MAX_ITEMS, TodoItemSchema } from '../todos/schemas';
import { ToolExecutionSnapshotSchema } from '../tool-executions/schemas';

// SSE error events are defined once in the errors module and re-exported here so
// streaming consumers keep a single canonical `SSEErrorEvent` shape.
export { type SSEErrorEvent, SSEErrorEventSchema } from '../errors';

const ContinuationReasonCodeSchema = Type.Union([
  Type.Literal('provider_changed'),
  Type.Literal('model_changed'),
  Type.Literal('system_prompt_changed'),
  Type.Literal('toolset_changed'),
  Type.Literal('agent_changed'),
  Type.Literal('agent_runtime_changed'),
  Type.Literal('cursor_expired'),
  Type.Literal('cursor_invalid'),
  Type.Literal('tool_result_cursor_loss'),
  Type.Literal('envelope_malformed'),
]);

export const SSEUserMessageIdEventSchema = Type.Object({
  type: Type.Literal('user_message_id'),
  messageId: Type.String(),
  done: Type.Literal(false),
});

export type SSEUserMessageIdEvent = Static<typeof SSEUserMessageIdEventSchema>;

const SSEAssistantMessageIdEventSchema = Type.Object({
  type: Type.Literal('assistant_message_id'),
  messageId: Type.String(),
  done: Type.Literal(false),
});

export const SSEThinkingStartEventSchema = Type.Object({
  type: Type.Literal('thinking_start'),
  done: Type.Literal(false),
});

export type SSEThinkingStartEvent = Static<typeof SSEThinkingStartEventSchema>;

export const SSEThinkingEventSchema = Type.Object({
  type: Type.Literal('thinking'),
  text: Type.String(),
  done: Type.Literal(false),
});

export type SSEThinkingEvent = Static<typeof SSEThinkingEventSchema>;

export const SSETextEventSchema = Type.Object({
  type: Type.Literal('text'),
  text: Type.String(),
  done: Type.Literal(false),
});

export type SSETextEvent = Static<typeof SSETextEventSchema>;

export const SSEToolCallStartedEventSchema = Type.Object({
  type: Type.Literal('tool_call_started'),
  callId: Type.String(),
  name: Type.String(),
  done: Type.Literal(false),
});

export type SSEToolCallStartedEvent = Static<typeof SSEToolCallStartedEventSchema>;

export const SSEToolCallCompletedEventSchema = Type.Object({
  type: Type.Literal('tool_call_completed'),
  callId: Type.String(),
  name: Type.String(),
  arguments: Type.String(),
  done: Type.Literal(false),
});

export type SSEToolCallCompletedEvent = Static<typeof SSEToolCallCompletedEventSchema>;

export const SSEToolResultEventSchema = Type.Object({
  type: Type.Literal('tool_result'),
  callId: Type.String(),
  result: Type.Unknown(),
  isError: Type.Optional(Type.Boolean()),
  done: Type.Literal(false),
});

export type SSEToolResultEvent = Static<typeof SSEToolResultEventSchema>;

/**
 * One lifecycle transition of a tool call, emitted by the execution owner on
 * every state change (queued, running, awaiting_user, and exactly one terminal
 * state). Carries the full snapshot so consumers upsert instead of patching.
 */
export const SSEToolExecutionEventSchema = Type.Object({
  type: Type.Literal('tool_execution'),
  callId: Type.String(),
  name: Type.String(),
  execution: ToolExecutionSnapshotSchema,
  done: Type.Literal(false),
});

export type SSEToolExecutionEvent = Static<typeof SSEToolExecutionEventSchema>;

export const SSESubagentStartedEventSchema = Type.Object({
  type: Type.Literal('subagent_started'),
  callId: Type.String(),
  agentId: Type.String(),
  agentName: Type.String(),
  task: Type.String(),
  done: Type.Literal(false),
});

export type SSESubagentStartedEvent = Static<typeof SSESubagentStartedEventSchema>;

export const SSESubagentTextEventSchema = Type.Object({
  type: Type.Literal('subagent_text'),
  callId: Type.String(),
  agentId: Type.String(),
  text: Type.String(),
  done: Type.Literal(false),
});

export type SSESubagentTextEvent = Static<typeof SSESubagentTextEventSchema>;

export const SSESubagentToolCallStartedEventSchema = Type.Object({
  type: Type.Literal('subagent_tool_call_started'),
  callId: Type.String(),
  agentId: Type.String(),
  toolCallId: Type.String(),
  name: Type.String(),
  done: Type.Literal(false),
});

export type SSESubagentToolCallStartedEvent = Static<typeof SSESubagentToolCallStartedEventSchema>;

export const SSESubagentCompletedEventSchema = Type.Object({
  type: Type.Literal('subagent_completed'),
  callId: Type.String(),
  agentId: Type.String(),
  agentName: Type.String(),
  summary: Type.String(),
  toolCallCount: Type.Number(),
  done: Type.Literal(false),
});

export type SSESubagentCompletedEvent = Static<typeof SSESubagentCompletedEventSchema>;

export const SSESubagentFailedEventSchema = Type.Object({
  type: Type.Literal('subagent_failed'),
  callId: Type.String(),
  agentId: Type.String(),
  agentName: Type.Optional(Type.String()),
  error: Type.String(),
  done: Type.Literal(false),
});

export type SSESubagentFailedEvent = Static<typeof SSESubagentFailedEventSchema>;

export const SSEImageGenerationStartedEventSchema = Type.Object({
  type: Type.Literal('image_generation_started'),
  imageId: Type.String(),
  toolCallId: Type.String(),
  prompt: Type.String(),
  done: Type.Literal(false),
});

export type SSEImageGenerationStartedEvent = Static<typeof SSEImageGenerationStartedEventSchema>;

export const SSEImageGenerationCompletedEventSchema = Type.Object({
  type: Type.Literal('image_generation_completed'),
  imageId: Type.String(),
  toolCallId: Type.String(),
  prompt: Type.String(),
  imageUrl: Type.String(),
  modelName: Type.Optional(Type.String()),
  generationTime: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSEImageGenerationCompletedEvent = Static<
  typeof SSEImageGenerationCompletedEventSchema
>;

export const SSEImageGenerationFailedEventSchema = Type.Object({
  type: Type.Literal('image_generation_failed'),
  imageId: Type.String(),
  toolCallId: Type.String(),
  prompt: Type.String(),
  error: Type.String(),
  errorCode: Type.Optional(ImageGenerationErrorCodeSchema),
  modelName: Type.Optional(Type.String()),
  generationTime: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSEImageGenerationFailedEvent = Static<typeof SSEImageGenerationFailedEventSchema>;

export const SSEMcpMediaEventSchema = Type.Object({
  type: Type.Literal('mcp_media'),
  toolCallId: Type.String(),
  serverSlug: Type.String(),
  toolName: Type.String(),
  kind: Type.Union([Type.Literal('image'), Type.Literal('resource')]),
  mimeType: Type.String(),
  url: Type.String(),
  uri: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSEMcpMediaEvent = Static<typeof SSEMcpMediaEventSchema>;

export const SSEQuestionEventSchema = Type.Object({
  type: Type.Literal('question'),
  toolCallId: Type.String(),
  questions: Type.Array(QuestionSpecSchema),
  done: Type.Literal(false),
});

export type SSEQuestionEvent = Static<typeof SSEQuestionEventSchema>;

export const SSEMcpElicitationRequestEventSchema = Type.Object({
  type: Type.Literal('mcp_elicitation_request'),
  elicitationId: Type.String(),
  toolCallId: Type.String(),
  serverSlug: Type.String(),
  message: Type.String(),
  fields: Type.Array(McpElicitationFieldSchema),
  status: McpElicitationStatusSchema,
  done: Type.Literal(false),
});

export type SSEMcpElicitationRequestEvent = Static<typeof SSEMcpElicitationRequestEventSchema>;

/**
 * First terminal transition of an already-streamed elicitation request, so a
 * mounted card becomes non-interactive without waiting for a refetch.
 */
const SSEMcpElicitationStatusEventSchema = Type.Object({
  type: Type.Literal('mcp_elicitation_status'),
  elicitationId: Type.String(),
  toolCallId: Type.String(),
  status: McpElicitationTerminalStatusSchema,
  reason: McpElicitationTerminalReasonSchema,
  done: Type.Literal(false),
});

export const SSETodoUpdateEventSchema = Type.Object({
  type: Type.Literal('todo_update'),
  toolCallId: Type.String(),
  todos: Type.Array(TodoItemSchema, { maxItems: TODO_MAX_ITEMS }),
  done: Type.Literal(false),
});

export type SSETodoUpdateEvent = Static<typeof SSETodoUpdateEventSchema>;

export const SSEContextEventSchema = Type.Object({
  type: Type.Literal('context_info'),
  estimatedInputTokens: Type.Number(),
  contextLimit: Type.Number(),
  estimatedUsageRatio: Type.Number(),
  mode: Type.Union([
    Type.Literal('stateful'),
    Type.Literal('stateless-loop'),
    Type.Literal('replay'),
    Type.Literal('compacted'),
    Type.Literal('degraded'),
  ]),
  severity: Type.Union([
    Type.Literal('normal'),
    Type.Literal('info'),
    Type.Literal('warning'),
    Type.Literal('danger'),
    Type.Literal('critical'),
  ]),
  done: Type.Literal(false),
});

export type SSEContextEvent = Static<typeof SSEContextEventSchema>;

export const SSEFallbackEventSchema = Type.Object({
  type: Type.Literal('fallback_notice'),
  from: Type.String(),
  to: Type.String(),
  reason: Type.String(),
  done: Type.Literal(false),
});

export type SSEFallbackEvent = Static<typeof SSEFallbackEventSchema>;

export const SSESystemEventSchema = Type.Object({
  type: Type.Literal('system_event'),
  event: Type.String(),
  detail: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSESystemEvent = Static<typeof SSESystemEventSchema>;

export const SSEContinuationTransitionEventSchema = Type.Object({
  type: Type.Literal('continuation_transition'),
  provider: ProviderTypeSchema,
  modelName: Type.String(),
  fromProvider: Type.Optional(ProviderTypeSchema),
  fromMode: Type.String(),
  toMode: Type.String(),
  reasonCode: ContinuationReasonCodeSchema,
  detail: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

export type SSEContinuationTransitionEvent = Static<typeof SSEContinuationTransitionEventSchema>;

/**
 * An external turn's vocabulary, deliberately parallel to the internal one.
 *
 * Every member is prefixed `external_` and none of them reuses `text`,
 * `thinking`, `tool_call_started` or `mcp_elicitation_request`. The internal
 * chunks carry MangoStudio's own assumptions — a tool the executor can re-run, a
 * thinking block the model produced, an elicitation MangoStudio's MCP client
 * owns — and a vendor's output entering any of those paths is precisely the
 * failure the whole external-agents contract exists to prevent.
 *
 * The pair below mirrors `mcp_elicitation_request` / `mcp_elicitation_status`:
 * a mid-turn question asked over the stream and answered on a separate endpoint,
 * with a status chunk so a mounted card goes inert without a refetch.
 */
const SSEExternalSessionStartedEventSchema = Type.Object({
  type: Type.Literal('external_session_started'),
  /** The hub-minted session id. The vendor's own handle never leaves the server. */
  sessionId: Type.String(),
  targetId: ExternalAgentTargetIdSchema,
  resumed: Type.Boolean(),
  fallbackReason: Type.Optional(Type.String()),
  done: Type.Literal(false),
});

const SSEExternalTextEventSchema = Type.Object({
  type: Type.Literal('external_text'),
  text: Type.String(),
  done: Type.Literal(false),
});

/**
 * A reasoning phase opened, with nothing to show yet.
 *
 * On current models the API default is `thinking.display: "omitted"`: the
 * block opens and closes with zero `thinking_delta` text, so without this a
 * whole reasoning phase renders as nothing — not even a pulse — while the
 * vendor keeps the turn open. Internal turns have `thinking_start` for
 * exactly this; external turns had no equivalent until now.
 */
const SSEExternalReasoningStartedEventSchema = Type.Object({
  type: Type.Literal('external_reasoning_started'),
  done: Type.Literal(false),
});

/**
 * The reasoning phase opened by `external_reasoning_started` closed.
 *
 * What lets the live transcript decide the same way a reloaded one does: a
 * phase that closed with no text was withheld and is dropped, wherever it sits;
 * one still open when the turn ends is the part the turn stopped inside.
 */
const SSEExternalReasoningEndedEventSchema = Type.Object({
  type: Type.Literal('external_reasoning_ended'),
  done: Type.Literal(false),
});

const SSEExternalReasoningEventSchema = Type.Object({
  type: Type.Literal('external_reasoning'),
  text: Type.String(),
  done: Type.Literal(false),
});

const SSEExternalActivityStartedEventSchema = Type.Object({
  type: Type.Literal('external_activity_started'),
  callId: Type.String(),
  /** The vendor's own tool name, verbatim. Rendered as plain text, never markdown. */
  name: Type.String(),
  kind: ExternalActivityKindSchema,
  title: Type.String(),
  detail: Type.Optional(Type.String()),
  truncated: Type.Optional(Type.Boolean()),
  done: Type.Literal(false),
});

const SSEExternalActivityUpdatedEventSchema = Type.Object({
  type: Type.Literal('external_activity_updated'),
  callId: Type.String(),
  update: ExternalActivityUpdateSchema,
  done: Type.Literal(false),
});

const SSEExternalActivityCompletedEventSchema = Type.Object({
  type: Type.Literal('external_activity_completed'),
  callId: Type.String(),
  status: ExternalActivityStatusSchema,
  detail: Type.Optional(Type.String()),
  isError: Type.Optional(Type.Boolean()),
  truncated: Type.Optional(Type.Boolean()),
  done: Type.Literal(false),
});

const SSEExternalApprovalRequestEventSchema = Type.Object({
  type: Type.Literal('external_approval_request'),
  requestId: Type.String(),
  kind: ExternalActivityKindSchema,
  title: Type.String(),
  detail: Type.Optional(Type.String()),
  /** The vendor's option set, in the vendor's order. Never reordered or renamed. */
  options: Type.Array(ExternalApprovalOptionSchema, { minItems: 1, maxItems: 16 }),
  expiresAtMs: Type.Integer({ minimum: 0 }),
  truncated: Type.Optional(Type.Boolean()),
  done: Type.Literal(false),
});

const SSEExternalApprovalStatusEventSchema = Type.Object({
  type: Type.Literal('external_approval_status'),
  requestId: Type.String(),
  decision: ExternalApprovalDecisionSchema,
  done: Type.Literal(false),
});

const SSEExternalUsageEventSchema = Type.Object({
  type: Type.Literal('external_usage'),
  usage: ExternalUsageSchema,
  done: Type.Literal(false),
});

const SSEExternalThreadUsageEventSchema = Type.Object({
  type: Type.Literal('external_thread_usage'),
  usage: ExternalThreadUsageSchema,
  done: Type.Literal(false),
});

/**
 * The slash commands this session can expand, announced by the vendor.
 *
 * Live state, not a message part: nothing about it is persisted, and a reload
 * falls back to what the library scanned on disk until the next turn announces
 * the catalog again. That asymmetry is deliberate — the vendor's list is the
 * only one that knows about plugin commands and builtin skills, and it only
 * exists once a process has started.
 */
const SSEExternalCommandsEventSchema = Type.Object({
  type: Type.Literal('external_commands'),
  commands: Type.Array(ExternalAgentCommandSchema, {
    maxItems: EXTERNAL_COMMAND_CATALOG_MAX_ITEMS,
  }),
  done: Type.Literal(false),
});

const SSEExternalAccountLimitsEventSchema = Type.Object({
  type: Type.Literal('external_account_limits'),
  limits: ExternalAccountLimitsSchema,
  /**
   * The vendor account the turn was bound to when it started, which is the
   * account this reading describes — the hub caches it under exactly this value.
   *
   * The snapshot itself names only a target, and a client that resolved the
   * account from its own discovery cache would file a reading from account A
   * under account B the moment discovery noticed a switch mid-turn. Absent when
   * the vendor has no account to fingerprint.
   */
  vendorAccountFingerprint: Type.Optional(Type.String({ maxLength: 128 })),
  done: Type.Literal(false),
});

/**
 * Announces what became of a mid-turn steer, live.
 *
 * Hub-originated rather than projected from a vendor event — steering is the
 * user talking to a turn that is still running, not the vendor reporting
 * something — so it is built directly by the turn controller, the same way
 * `external_session_started` and `external_turn_completed` are. One chunk per
 * attempt: the durable record starts `accepted` optimistically and is
 * corrected in place on a rejection, but the client only needs the resolved
 * outcome, not the intermediate state nobody could have acted on anyway.
 */
const SSEExternalSteerEventSchema = Type.Union([
  Type.Object(
    {
      type: Type.Literal('external_steer'),
      clientMessageId: Type.String(),
      text: Type.String(),
      status: Type.Literal('accepted'),
      done: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      type: Type.Literal('external_steer'),
      clientMessageId: Type.String(),
      text: Type.String(),
      status: Type.Literal('rejected'),
      reasonCode: ExternalSteerRejectionReasonSchema,
      done: Type.Literal(false),
    },
    { additionalProperties: false }
  ),
]);

/**
 * A vendor failure with its structure intact, distinct from `error`.
 *
 * `SSEErrorEvent` is terminal (`done: true`) and carries a flat message. A
 * vendor error has a code, a request id and a retry hint that the turn record
 * keeps, and the turn still ends through its own terminal path afterwards.
 */
const SSEExternalErrorEventSchema = Type.Object({
  type: Type.Literal('external_error'),
  error: ExternalAgentErrorSchema,
  done: Type.Literal(false),
});

/**
 * How the turn ended, as data rather than as prose.
 *
 * The vendor's own `completed` and `error` are only two of nine ways a turn
 * stops — the other seven are the hub's verdict on a vendor that stopped being
 * reachable, answerable or affordable. The durable record keeps all nine on
 * `external_turn.terminalReason`, so the live stream has to carry the same value
 * or a reload changes what the user is told about a turn they just watched.
 */
const SSEExternalTurnCompletedEventSchema = Type.Object({
  type: Type.Literal('external_turn_completed'),
  reason: ExternalTurnTerminalReasonSchema,
  done: Type.Literal(false),
});

export const SSEDoneEventSchema = Type.Object({
  type: Type.Literal('done'),
  done: Type.Literal(true),
  messageId: Type.Optional(Type.String()),
  generationTime: Type.Optional(Type.String()),
});

export type SSEDoneEvent = Static<typeof SSEDoneEventSchema>;

/** Discriminated union of every SSE chunk emitted by the streaming endpoint. */
export const StreamChunkSchema = Type.Union([
  SSEUserMessageIdEventSchema,
  SSEAssistantMessageIdEventSchema,
  SSEThinkingStartEventSchema,
  SSEThinkingEventSchema,
  SSETextEventSchema,
  SSEToolCallStartedEventSchema,
  SSEToolCallCompletedEventSchema,
  SSEToolResultEventSchema,
  SSEToolExecutionEventSchema,
  SSESubagentStartedEventSchema,
  SSESubagentTextEventSchema,
  SSESubagentToolCallStartedEventSchema,
  SSESubagentCompletedEventSchema,
  SSESubagentFailedEventSchema,
  SSEImageGenerationStartedEventSchema,
  SSEImageGenerationCompletedEventSchema,
  SSEImageGenerationFailedEventSchema,
  SSEMcpMediaEventSchema,
  SSEQuestionEventSchema,
  SSEMcpElicitationRequestEventSchema,
  SSEMcpElicitationStatusEventSchema,
  SSETodoUpdateEventSchema,
  SSEContextEventSchema,
  SSEFallbackEventSchema,
  SSESystemEventSchema,
  SSEContinuationTransitionEventSchema,
  SSEExternalSessionStartedEventSchema,
  SSEExternalTextEventSchema,
  SSEExternalReasoningStartedEventSchema,
  SSEExternalReasoningEndedEventSchema,
  SSEExternalReasoningEventSchema,
  SSEExternalActivityStartedEventSchema,
  SSEExternalActivityUpdatedEventSchema,
  SSEExternalActivityCompletedEventSchema,
  SSEExternalApprovalRequestEventSchema,
  SSEExternalApprovalStatusEventSchema,
  SSEExternalUsageEventSchema,
  SSEExternalThreadUsageEventSchema,
  SSEExternalAccountLimitsEventSchema,
  SSEExternalCommandsEventSchema,
  SSEExternalSteerEventSchema,
  SSEExternalErrorEventSchema,
  SSEExternalTurnCompletedEventSchema,
  SSEDoneEventSchema,
  SSEErrorEventSchema,
]);

export type StreamChunk = Static<typeof StreamChunkSchema>;
