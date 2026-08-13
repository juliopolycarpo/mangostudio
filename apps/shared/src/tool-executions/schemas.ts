import Type, { type Static } from 'typebox';

export const TOOL_EXECUTION_STATUSES = [
  'queued',
  'running',
  'awaiting_user',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const ToolExecutionStatusSchema = Type.Union([
  Type.Literal('queued'),
  Type.Literal('running'),
  Type.Literal('awaiting_user'),
  Type.Literal('succeeded'),
  Type.Literal('failed'),
  Type.Literal('cancelled'),
  Type.Literal('timed_out'),
]);

export type ToolExecutionStatus = Static<typeof ToolExecutionStatusSchema>;

export const TOOL_EXECUTION_SOURCES = ['builtin', 'skill', 'mcp', 'subagent'] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const ToolExecutionSourceSchema = Type.Union([
  Type.Literal('builtin'),
  Type.Literal('skill'),
  Type.Literal('mcp'),
  Type.Literal('subagent'),
]);

export type ToolExecutionSource = Static<typeof ToolExecutionSourceSchema>;

/**
 * Safe, enumerable explanation for a terminal transition. Free-text detail
 * never travels in the snapshot; the sanitized error message lives in the
 * matching tool_result content instead.
 */
export const TOOL_EXECUTION_REASON_CODES = [
  'timeout',
  'user_cancelled',
  'turn_aborted',
  'not_allowed',
  'tool_disabled',
  'unknown_tool',
  'validation_failed',
  'server_closed',
  'execution_error',
  'outcome_unknown',
] as const;

// Written as a literal tuple rather than mapped from the array above:
// TypeBox infers a union by walking a tuple, and a mapped array widens to
// `TSchema[]`, which infers as `never` and silently erases the type.
export const ToolExecutionReasonCodeSchema = Type.Union([
  Type.Literal('timeout'),
  Type.Literal('user_cancelled'),
  Type.Literal('turn_aborted'),
  Type.Literal('not_allowed'),
  Type.Literal('tool_disabled'),
  Type.Literal('unknown_tool'),
  Type.Literal('validation_failed'),
  Type.Literal('server_closed'),
  Type.Literal('execution_error'),
  Type.Literal('outcome_unknown'),
]);

export type ToolExecutionReasonCode = Static<typeof ToolExecutionReasonCodeSchema>;

/**
 * Provider-independent lifecycle snapshot of one tool call, persisted on the
 * `tool_call` message part and streamed on every transition. Timestamps are
 * wall-clock epoch millis; `durationMs` is measured from monotonic time by the
 * execution owner, so it stays correct across clock adjustments.
 */
export const ToolExecutionSnapshotSchema = Type.Object({
  status: ToolExecutionStatusSchema,
  source: ToolExecutionSourceSchema,
  queuedAt: Type.Number(),
  startedAt: Type.Optional(Type.Number()),
  awaitingUserAt: Type.Optional(Type.Number()),
  finishedAt: Type.Optional(Type.Number()),
  durationMs: Type.Optional(Type.Number({ minimum: 0 })),
  reasonCode: Type.Optional(ToolExecutionReasonCodeSchema),
});

export type ToolExecutionSnapshot = Static<typeof ToolExecutionSnapshotSchema>;
