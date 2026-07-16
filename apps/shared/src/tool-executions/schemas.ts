import { type Static, Type } from '@sinclair/typebox';

export const TOOL_EXECUTION_STATUSES = [
  'queued',
  'running',
  'awaiting_user',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
] as const;

export const ToolExecutionStatusSchema = Type.Union(
  TOOL_EXECUTION_STATUSES.map((status) => Type.Literal(status))
);

export type ToolExecutionStatus = Static<typeof ToolExecutionStatusSchema>;

export const TOOL_EXECUTION_SOURCES = ['builtin', 'skill', 'mcp', 'subagent'] as const;

export const ToolExecutionSourceSchema = Type.Union(
  TOOL_EXECUTION_SOURCES.map((source) => Type.Literal(source))
);

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

export const ToolExecutionReasonCodeSchema = Type.Union(
  TOOL_EXECUTION_REASON_CODES.map((code) => Type.Literal(code))
);

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
