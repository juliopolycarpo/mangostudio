import Type, { type Static } from 'typebox';

import type { ToolExecutionReasonCode, ToolExecutionStatus, ToolRetrySafety } from './schemas';

/** Body of `POST /chats/:id/messages/:messageId/tool-calls/:callId/retry`. */
export const RetryToolCallBodySchema = Type.Object({
  /**
   * The reader approved the confirmation naming the tool and its arguments.
   * Required when the policy asks first; ignored for a call that runs directly.
   */
  confirmed: Type.Optional(Type.Boolean()),
});
export type RetryToolCallBody = Static<typeof RetryToolCallBodySchema>;

/** Why a call is not offered a retry. */
export type ToolCallRetryRefusal =
  /** It has not ended, or it ended well: there is nothing to run again. */
  | 'not_terminal'
  /** Policy refused it before it ran, and the same inputs get the same refusal. */
  | 'same_refusal'
  /** The call recorded no retry policy (it never started, or predates the field). */
  | 'no_policy'
  /** The tool needs a model or the reader's answer to finish, which a tool-only run has neither of. */
  | 'needs_model';

export type ToolCallRetryEligibility =
  | {
      readonly eligible: true;
      /** `none` runs on click; `required` shows a confirmation naming the tool and its arguments first. */
      readonly confirmation: 'none' | 'required';
    }
  | { readonly eligible: false; readonly reason: ToolCallRetryRefusal };

/** Reasons the same call would be refused again, so offering a retry only repeats the failure. */
const SAME_REFUSAL_REASONS: ReadonlySet<ToolExecutionReasonCode> = new Set([
  'not_allowed',
  'tool_disabled',
  'unknown_tool',
  'validation_failed',
]);

/**
 * Builtins a tool-only run cannot finish: image generation streams its own
 * artifacts, delegation runs a subagent turn, and a question waits for an
 * answer that arrives as the next message. Matched by name because the hub's
 * tool constants live in the API workspace.
 */
export const TOOLS_NEEDING_A_MODEL_TURN: ReadonlySet<string> = new Set([
  'generate_image',
  'delegate_to_agent',
  'ask_user_question',
]);

const RETRYABLE_STATUSES: ReadonlySet<ToolExecutionStatus> = new Set([
  'failed',
  'cancelled',
  'timed_out',
]);

/**
 * Whether a settled call may be run again, and whether that needs the reader's
 * approval first. One function for the hub's refusal and the card's button, so
 * the button cannot offer what the endpoint will refuse.
 *
 * Only `failed`, `cancelled` and `timed_out` offer a retry. `outcome_unknown`
 * always asks, whatever the tool's policy: the call may have taken effect.
 * `safe_read` runs directly; every other policy asks.
 *
 * // Usage: resolveToolCallRetryEligibility({ name, status, reasonCode, retrySafety })
 */
export function resolveToolCallRetryEligibility(call: {
  readonly name: string;
  readonly status: ToolExecutionStatus;
  readonly reasonCode?: ToolExecutionReasonCode;
  readonly retrySafety?: ToolRetrySafety;
}): ToolCallRetryEligibility {
  if (!RETRYABLE_STATUSES.has(call.status)) return { eligible: false, reason: 'not_terminal' };
  if (TOOLS_NEEDING_A_MODEL_TURN.has(call.name)) return { eligible: false, reason: 'needs_model' };
  if (call.reasonCode !== undefined && SAME_REFUSAL_REASONS.has(call.reasonCode)) {
    return { eligible: false, reason: 'same_refusal' };
  }
  if (call.retrySafety === undefined) return { eligible: false, reason: 'no_policy' };
  if (call.reasonCode === 'outcome_unknown') return { eligible: true, confirmation: 'required' };
  return { eligible: true, confirmation: call.retrySafety === 'safe_read' ? 'none' : 'required' };
}
