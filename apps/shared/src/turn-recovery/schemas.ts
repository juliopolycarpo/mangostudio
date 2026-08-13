import Type, { type Static } from 'typebox';
import Value from 'typebox/value';
import { AgentIdSchema } from '../agents/schemas';
import { ProviderTypeSchema } from '../provider-settings/schemas';
import { TODO_MAX_ITEMS, TodoItemSchema } from '../todos/schemas';
import { ToolExecutionStatusSchema } from '../tool-executions/schemas';

export const TURN_RECOVERY_VERSION = 1 as const;
export const TURN_RECOVERY_MAX_CALLS = 50;
export const TURN_RECOVERY_MAX_RESULT_LENGTH = 2_000;
export const TURN_RECOVERY_MAX_TEXT_LENGTH = 8_000;
export const TURN_RECOVERY_MAX_RETRY_CALLS = 50;

export const TURN_CHECKPOINT_STATUSES = [
  'active',
  'completed',
  'interrupted',
  'dismissed',
  'resumed',
] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const TurnCheckpointStatusSchema = Type.Union([
  Type.Literal('active'),
  Type.Literal('completed'),
  Type.Literal('interrupted'),
  Type.Literal('dismissed'),
  Type.Literal('resumed'),
]);
export type TurnCheckpointStatus = Static<typeof TurnCheckpointStatusSchema>;

export const TURN_INTERRUPTION_REASON_CODES = [
  'client_disconnect',
  'server_restart',
  'provider_error',
  'user_cancelled',
  'tool_loop_exhausted',
  'unknown',
] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const TurnInterruptionReasonCodeSchema = Type.Union([
  Type.Literal('client_disconnect'),
  Type.Literal('server_restart'),
  Type.Literal('provider_error'),
  Type.Literal('user_cancelled'),
  Type.Literal('tool_loop_exhausted'),
  Type.Literal('unknown'),
]);
export type TurnInterruptionReasonCode = Static<typeof TurnInterruptionReasonCodeSchema>;

export const TOOL_RETRY_SAFETY_VALUES = ['safe_read', 'confirmation_required', 'unknown'] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const ToolRetrySafetySchema = Type.Union([
  Type.Literal('safe_read'),
  Type.Literal('confirmation_required'),
  Type.Literal('unknown'),
]);
export type ToolRetrySafety = Static<typeof ToolRetrySafetySchema>;

export const IncompleteToolCallOutcomeSchema = Type.Union([
  Type.Literal('not_started'),
  Type.Literal('interrupted'),
  Type.Literal('unknown'),
]);
export type IncompleteToolCallOutcome = Static<typeof IncompleteToolCallOutcomeSchema>;

export const CompletedToolCallSchema = Type.Object({
  callId: Type.String({ maxLength: 256 }),
  name: Type.String({ maxLength: 256 }),
  retrySafety: ToolRetrySafetySchema,
  result: Type.String({ maxLength: TURN_RECOVERY_MAX_RESULT_LENGTH }),
  isError: Type.Optional(Type.Boolean()),
});
export type CompletedToolCall = Static<typeof CompletedToolCallSchema>;

export const IncompleteToolCallSchema = Type.Object({
  callId: Type.String({ maxLength: 256 }),
  name: Type.String({ maxLength: 256 }),
  retrySafety: ToolRetrySafetySchema,
  status: ToolExecutionStatusSchema,
  outcome: IncompleteToolCallOutcomeSchema,
});
export type IncompleteToolCall = Static<typeof IncompleteToolCallSchema>;

export const TurnResumeRecordSchema = Type.Object({
  requestId: Type.String({ minLength: 1, maxLength: 256 }),
  userMessageId: Type.String({ maxLength: 256 }),
  assistantMessageId: Type.String({ maxLength: 256 }),
  resumedAt: Type.Number(),
});
export type TurnResumeRecord = Static<typeof TurnResumeRecordSchema>;

/**
 * Durable, bounded recovery metadata stored beside assistant content. The
 * message row remains the turn checkpoint; this part only records the state
 * needed to explain and safely continue it.
 */
export const TurnCheckpointPartSchema = Type.Object({
  type: Type.Literal('turn_checkpoint'),
  version: Type.Literal(TURN_RECOVERY_VERSION),
  turnId: Type.String({ maxLength: 256 }),
  status: TurnCheckpointStatusSchema,
  reasonCode: Type.Optional(TurnInterruptionReasonCodeSchema),
  sequence: Type.Integer({ minimum: 0 }),
  startedAt: Type.Number(),
  checkpointedAt: Type.Number(),
  provider: ProviderTypeSchema,
  modelName: Type.String({ maxLength: 256 }),
  agentId: AgentIdSchema,
  agentName: Type.Optional(Type.String({ maxLength: 256 })),
  lastAssistantText: Type.String({ maxLength: TURN_RECOVERY_MAX_TEXT_LENGTH }),
  todoSnapshot: Type.Array(TodoItemSchema, { maxItems: TODO_MAX_ITEMS }),
  completedCalls: Type.Array(CompletedToolCallSchema, { maxItems: TURN_RECOVERY_MAX_CALLS }),
  incompleteCalls: Type.Array(IncompleteToolCallSchema, { maxItems: TURN_RECOVERY_MAX_CALLS }),
  resume: Type.Optional(TurnResumeRecordSchema),
});
export type TurnCheckpointPart = Static<typeof TurnCheckpointPartSchema>;

export const ResumeInterruptedTurnSchema = Type.Object({
  messageId: Type.String({ minLength: 1, maxLength: 256 }),
  requestId: Type.String({ minLength: 1, maxLength: 256 }),
  retryCallIds: Type.Array(Type.String({ minLength: 1, maxLength: 256 }), {
    maxItems: TURN_RECOVERY_MAX_RETRY_CALLS,
    uniqueItems: true,
  }),
});
export type ResumeInterruptedTurn = Static<typeof ResumeInterruptedTurnSchema>;

export const TurnRecoveryActionResponseSchema = Type.Object({
  messageId: Type.String(),
  status: Type.Union([Type.Literal('interrupted'), Type.Literal('dismissed')]),
});
export type TurnRecoveryActionResponse = Static<typeof TurnRecoveryActionResponseSchema>;

export function isTurnCheckpointPart(value: unknown): value is TurnCheckpointPart {
  // Callers scan every part of every message, so reject on the cheap
  // discriminator before paying for full schema validation.
  if (
    typeof value !== 'object' ||
    value === null ||
    (value as { type?: unknown }).type !== 'turn_checkpoint'
  ) {
    return false;
  }
  return Value.Check(TurnCheckpointPartSchema, value);
}
