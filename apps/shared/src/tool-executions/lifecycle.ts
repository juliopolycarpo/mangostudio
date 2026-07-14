import type {
  ToolExecutionReasonCode,
  ToolExecutionSnapshot,
  ToolExecutionSource,
  ToolExecutionStatus,
} from './schemas';

const TERMINAL_STATUSES: ReadonlySet<ToolExecutionStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);

/**
 * Every legal lifecycle edge. Terminal states have no outgoing edges, and a
 * call can only reach a terminal state once — the first terminal transition
 * wins and later ones are ignored by {@link applyToolExecutionTransition}.
 */
const VALID_TRANSITIONS: Readonly<Record<ToolExecutionStatus, ReadonlySet<ToolExecutionStatus>>> = {
  queued: new Set(['running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  running: new Set(['awaiting_user', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  awaiting_user: new Set(['running', 'succeeded', 'failed', 'cancelled', 'timed_out']),
  succeeded: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
};

export function isTerminalToolExecutionStatus(status: ToolExecutionStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function canTransitionToolExecution(
  from: ToolExecutionStatus,
  to: ToolExecutionStatus
): boolean {
  return VALID_TRANSITIONS[from].has(to);
}

export interface ToolExecutionTransition {
  status: ToolExecutionStatus;
  /** Wall-clock epoch millis of the transition. */
  at: number;
  /** Monotonic elapsed millis; only meaningful on a terminal transition. */
  durationMs?: number;
  /** Only meaningful on a terminal transition. */
  reasonCode?: ToolExecutionReasonCode;
}

/** Creates the initial `queued` snapshot for a scheduled tool call. */
export function createToolExecutionSnapshot(
  source: ToolExecutionSource,
  queuedAt: number
): ToolExecutionSnapshot {
  return { status: 'queued', source, queuedAt };
}

/**
 * Pure lifecycle reducer: applies one transition and stamps the timestamp
 * matching the target state. An invalid edge returns the snapshot unchanged,
 * which makes concurrent signals (e.g. a late elicitation event racing a
 * timeout) safe by construction — the first terminal state is immutable.
 *
 * // Usage: snapshot = applyToolExecutionTransition(snapshot, { status: 'running', at: Date.now() });
 */
export function applyToolExecutionTransition(
  snapshot: ToolExecutionSnapshot,
  transition: ToolExecutionTransition
): ToolExecutionSnapshot {
  if (!canTransitionToolExecution(snapshot.status, transition.status)) return snapshot;

  const next: ToolExecutionSnapshot = { ...snapshot, status: transition.status };
  if (transition.status === 'running' && next.startedAt === undefined) {
    next.startedAt = transition.at;
  }
  if (transition.status === 'awaiting_user') {
    next.awaitingUserAt = transition.at;
  }
  if (isTerminalToolExecutionStatus(transition.status)) {
    next.finishedAt = transition.at;
    if (transition.durationMs !== undefined) {
      next.durationMs = Math.max(0, Math.round(transition.durationMs));
    }
    if (transition.reasonCode !== undefined) {
      next.reasonCode = transition.reasonCode;
    }
  }
  return next;
}

export interface ToolCallLifecycleView {
  /** Lifecycle snapshot persisted with the tool_call part, when present. */
  execution?: ToolExecutionSnapshot;
  /** Whether a matching tool_result part exists. */
  hasResult: boolean;
  /** The matching tool_result error flag, when a result exists. */
  isError?: boolean;
  /** Whether the owning message is still streaming. */
  isStreaming: boolean;
}

/**
 * Read-time normalizer that maps any persisted or live tool_call part to a
 * lifecycle status. Legacy parts without a snapshot infer their state from the
 * matching tool_result (result => succeeded/failed); a part with no result on
 * a settled message was interrupted and reads as cancelled. The same policy
 * applies to a snapshot persisted mid-flight (e.g. by a crashed turn).
 */
export function resolveToolCallStatus(view: ToolCallLifecycleView): ToolExecutionStatus {
  const { execution, hasResult, isError, isStreaming } = view;
  if (execution) {
    if (isTerminalToolExecutionStatus(execution.status)) return execution.status;
    if (isStreaming) return execution.status;
    return hasResult ? resolveLegacyResultStatus(isError) : 'cancelled';
  }
  if (hasResult) return resolveLegacyResultStatus(isError);
  return isStreaming ? 'running' : 'cancelled';
}

function resolveLegacyResultStatus(isError: boolean | undefined): ToolExecutionStatus {
  return isError ? 'failed' : 'succeeded';
}

/** Statuses that render as in-flight in the UI. */
export function isActiveToolExecutionStatus(status: ToolExecutionStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'awaiting_user';
}

/**
 * Best-effort source classification for legacy parts persisted before
 * snapshots existed. New writes carry `source` in the snapshot; this mirrors
 * the API-side naming conventions (MCP namespace prefix, well-known builtin
 * names) for display only.
 */
export function inferToolExecutionSource(name: string): ToolExecutionSource {
  if (name.startsWith('mcp__')) return 'mcp';
  if (name === 'skill') return 'skill';
  if (name === 'delegate_to_agent') return 'subagent';
  return 'builtin';
}
