/**
 * API-side owner of the shared tool-execution lifecycle. Adapters report
 * outcomes (results, thrown errors, subagent statuses); this module maps them
 * onto the shared transition table, so no adapter can invent its own edges.
 */

import {
  applyToolExecutionTransition,
  createToolExecutionSnapshot,
  isTerminalToolExecutionStatus,
  type ToolExecutionReasonCode,
  type ToolExecutionSnapshot,
  type ToolExecutionSource,
  type ToolExecutionStatus,
} from '@mangostudio/shared/tool-executions';
import { classifyMcpCallFailure } from '../../../services/mcp/call-failure';
import { isMcpToolName } from '../../../services/mcp/tool-naming';
import { ToolArgumentError } from '../../../services/tools/arg-parsing';
import { DELEGATE_TO_AGENT_TOOL_NAME } from '../../../services/tools/builtin/delegate-to-agent';
import { SKILL_TOOL_NAME } from '../../../services/tools/builtin/skill';
import { ToolExecutionTimedOutError } from '../../../services/tools/execution-timeout';
import type { SubagentStatus } from './subagent-turn-types';
import { SubagentDelegationError } from './subagent-turn-types';

/** A tool call rejected by policy before or during dispatch. */
export class ToolPolicyError extends Error {
  constructor(
    message: string,
    readonly reasonCode: Extract<
      ToolExecutionReasonCode,
      'not_allowed' | 'tool_disabled' | 'unknown_tool'
    >
  ) {
    super(message);
    this.name = 'ToolPolicyError';
  }
}

export interface ToolExecutionTransitionEvent {
  type: 'tool_execution';
  callId: string;
  name: string;
  execution: ToolExecutionSnapshot;
}

export interface ToolFailureClassification {
  status: Extract<ToolExecutionStatus, 'failed' | 'cancelled' | 'timed_out'>;
  reasonCode: ToolExecutionReasonCode;
}

/**
 * Tracks one call's snapshot, emitting a transition event on every accepted
 * edge. Wall-clock timestamps come from `Date.now()`; the terminal duration is
 * measured with monotonic time from the moment the call actually started
 * running (falling back to queue time for calls rejected before start).
 */
export class ToolExecutionLifecycle {
  private snapshot: ToolExecutionSnapshot;
  private readonly queuedMonotonic = performance.now();
  private runningMonotonic: number | undefined;

  constructor(
    readonly callId: string,
    readonly name: string,
    private readonly emit?: (event: ToolExecutionTransitionEvent) => void
  ) {
    this.snapshot = createToolExecutionSnapshot(classifyToolExecutionSource(name), Date.now());
  }

  get current(): ToolExecutionSnapshot {
    return this.snapshot;
  }

  /** Announces the initial `queued` snapshot before the call is scheduled. */
  emitQueued(): void {
    this.emit?.(this.toEvent());
  }

  transition(status: ToolExecutionStatus, reasonCode?: ToolExecutionReasonCode): void {
    const terminal = isTerminalToolExecutionStatus(status);
    const next = applyToolExecutionTransition(this.snapshot, {
      status,
      at: Date.now(),
      ...(terminal
        ? { durationMs: performance.now() - (this.runningMonotonic ?? this.queuedMonotonic) }
        : {}),
      ...(reasonCode ? { reasonCode } : {}),
    });
    if (next === this.snapshot) return;
    if (status === 'running' && this.runningMonotonic === undefined) {
      this.runningMonotonic = performance.now();
    }
    this.snapshot = next;
    this.emit?.(this.toEvent());
  }

  /** Applies the terminal state for a thrown error via shared classification. */
  fail(error: unknown, parentSignal?: AbortSignal): void {
    const { status, reasonCode } = classifyToolExecutionFailure(error, parentSignal);
    this.transition(status, reasonCode);
  }

  private toEvent(): ToolExecutionTransitionEvent {
    return {
      type: 'tool_execution',
      callId: this.callId,
      name: this.name,
      execution: this.snapshot,
    };
  }
}

export function classifyToolExecutionSource(name: string): ToolExecutionSource {
  if (isMcpToolName(name)) return 'mcp';
  if (name === DELEGATE_TO_AGENT_TOOL_NAME) return 'subagent';
  if (name === SKILL_TOOL_NAME) return 'skill';
  return 'builtin';
}

/**
 * Normalizes a thrown execution error to one terminal state: distinguishes a
 * timeout (ours, a shell's own, or the MCP SDK's) from a parent-driven cancel
 * and from a plain failure with a policy/validation reason code.
 */
export function classifyToolExecutionFailure(
  error: unknown,
  parentSignal?: AbortSignal
): ToolFailureClassification {
  if (error instanceof ToolExecutionTimedOutError) {
    return { status: 'timed_out', reasonCode: 'timeout' };
  }
  // MCP aborts surface through the SDK as RequestTimeout even when the parent
  // signal initiated cancellation. The turn signal is the authoritative cause
  // in that race; otherwise a user stop is persisted as a server timeout.
  if (isAbortError(error) || parentSignal?.aborted) {
    return { status: 'cancelled', reasonCode: 'user_cancelled' };
  }
  const mcpFailure = classifyMcpCallFailure(error);
  if (mcpFailure === 'timeout') return { status: 'timed_out', reasonCode: 'timeout' };
  if (mcpFailure === 'server_closed') return { status: 'failed', reasonCode: 'server_closed' };
  if (error instanceof SubagentDelegationError) {
    return classifySubagentDelegationFailure(error);
  }
  if (error instanceof ToolPolicyError) {
    return { status: 'failed', reasonCode: error.reasonCode };
  }
  if (error instanceof ToolArgumentError) {
    return { status: 'failed', reasonCode: 'validation_failed' };
  }
  return { status: 'failed', reasonCode: 'execution_error' };
}

/** Maps a finished subagent run onto the shared terminal states. */
export function subagentStatusToTerminal(status: SubagentStatus): {
  status: Extract<ToolExecutionStatus, 'succeeded' | 'failed' | 'cancelled' | 'timed_out'>;
  reasonCode?: ToolExecutionReasonCode;
} {
  switch (status) {
    case 'completed':
      return { status: 'succeeded' };
    case 'aborted':
      return { status: 'cancelled', reasonCode: 'user_cancelled' };
    case 'timeout':
      return { status: 'timed_out', reasonCode: 'timeout' };
    case 'failed':
      return { status: 'failed', reasonCode: 'execution_error' };
  }
}

function classifySubagentDelegationFailure(
  error: SubagentDelegationError
): ToolFailureClassification {
  switch (error.code) {
    case 'TIMEOUT':
      return { status: 'timed_out', reasonCode: 'timeout' };
    case 'ABORTED':
      return { status: 'cancelled', reasonCode: 'user_cancelled' };
    case 'INVALID_AGENT_ID':
      return { status: 'failed', reasonCode: 'validation_failed' };
    case 'DISABLED':
    case 'CHAT_DISABLED':
      return { status: 'failed', reasonCode: 'tool_disabled' };
    case 'MAX_CALLS':
    case 'MAX_DEPTH':
      return { status: 'failed', reasonCode: 'not_allowed' };
    case 'UNKNOWN_TOOL':
      return { status: 'failed', reasonCode: 'unknown_tool' };
    default:
      return { status: 'failed', reasonCode: 'execution_error' };
  }
}

/** True when the thrown value is a DOM/Node AbortError (parent cancel). */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
