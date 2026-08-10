/**
 * Turning `session/request_permission` into a neutral approval, and a chosen
 * option back into ACP's own answer.
 *
 * The previous revision of this adapter's plan declared Cursor permanently
 * incapable of interactive approvals and told us to state the limitation
 * plainly. That was a property of print mode. ACP asks the client, blocks on the
 * answer, and hands over the vendor's own option set — so this file is the one
 * that has to be right, and its round-trip test is the one that matters most.
 *
 * **MangoStudio never alters a decision set.** The options are passed through
 * exactly as they arrived: same ids, same order, same labels, nothing added and
 * nothing dropped. There is no place in this file where an option is
 * constructed, and `encode` refuses an id the vendor did not send rather than
 * picking the nearest one.
 *
 * **Nothing here ever chooses.** `cancelledOutcome` exists for the cases where
 * there is nobody to ask — a turn that ended, a session that closed, an
 * approval that expired — and `cancelled` is ACP's own word for "the client is
 * not answering". Selecting a decline option on the user's behalf would be
 * MangoStudio answering a vendor's question about the user's machine.
 */

import {
  boundVendorText,
  EXTERNAL_APPROVAL_MAX_OPTIONS,
  EXTERNAL_TEXT_LIMITS,
  type ExternalActivityKind,
  type ExternalApprovalOption,
  type ExternalApprovalRequest,
} from '@mangostudio/shared/external-agents';
import type { AcpRequestPermissionParams, AcpRequestPermissionResponse } from './protocol';
import { activityKindFor, detailFields, toolCallDetail, toolCallTitle } from './tool-calls';

/**
 * How long an unanswered approval stays answerable.
 *
 * The same ten minutes the Codex adapter uses, for the same reason: long enough
 * for a person to read a diff and decide, short enough that a forgotten tab does
 * not pin a vendor process forever. The supervisor reads the `expiresAtMs` this
 * produces and suspends its idle timeout until then, so one number governs both
 * how long the card is live and how long the turn is allowed to wait.
 */
const CURSOR_APPROVAL_TTL_MS = 10 * 60_000;

/** JSON-RPC application error codes this client answers a server request with. */
const CURSOR_ERROR_CODES = {
  /** The method exists in ACP; this client will not serve it. */
  methodNotSupported: -32601,
  /** The method is served, but not for the shape that arrived. */
  invalidRequest: -32600,
} as const;

interface CursorRequestRefusal {
  readonly outcome: 'refuse';
  readonly code: number;
  readonly message: string;
}

export interface CursorRequestApproval {
  readonly outcome: 'approval';
  /**
   * The ACP session the vendor said this question is about.
   *
   * Kept beside the neutral request rather than inside it: the caller has to
   * correlate on it before the request is shown to anyone, and the shared
   * contract has no room for a vendor's own session id. Absent when the request
   * named no session at all, which correlates against nothing.
   */
  readonly nativeSessionId?: string;
  readonly request: ExternalApprovalRequest;
  /** Builds the ACP response for a chosen option, or throws for an id Cursor did not offer. */
  encode(optionId: string): AcpRequestPermissionResponse;
}

export type CursorServerRequestPlan = CursorRequestApproval | CursorRequestRefusal;

/**
 * The answer for "nobody is going to reply".
 *
 * Kept as a function rather than a constant so no call site can mistake it for
 * a decision that was made; every caller of it is a teardown path.
 */
export function cursorCancelledOutcome(): AcpRequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

/**
 * The answer for a question about a session this connection is not holding.
 *
 * An error rather than `cancelled`: `cancelled` says "nobody answered", which
 * would be a lie about a request that was understood and rejected — and the
 * distinction is what appears in the vendor's log when a mis-addressed request
 * comes back refused.
 */
export function cursorForeignSessionRefusal(): { readonly code: number; readonly message: string } {
  return {
    code: CURSOR_ERROR_CODES.invalidRequest,
    message: 'MangoStudio will not answer a permission request for another session.',
  };
}

/**
 * Which of Cursor's option kinds grants standing permission.
 *
 * Only `allow_always` does. A reject is never destructive however sticky it is,
 * and `allow_once` is the ordinary case; marking either would make the warning
 * the UI paints on a destructive option meaningless.
 */
function isDestructiveOption(kind: string | undefined): boolean {
  return kind === 'allow_always';
}

/**
 * Whether an opaque vendor id survives the crossing unchanged.
 *
 * Exactly the condition the runtime's own normalization applies before it
 * throws: an id that would be stripped, shortened or emptied is not one this
 * client can echo back to the vendor, so the request it belongs to is refused
 * rather than emitted.
 */
function isCarryableVendorId(raw: string): boolean {
  const bounded = boundVendorText(raw, 'vendorId');
  return !bounded.truncated && bounded.text.length > 0;
}

function toNeutralOption(option: {
  readonly optionId?: string;
  readonly name?: string;
  readonly kind?: string;
}): ExternalApprovalOption | undefined {
  const id = option.optionId;
  if (typeof id !== 'string' || id.length === 0) return undefined;
  return {
    id,
    isDestructive: isDestructiveOption(option.kind),
    // The vendor's own label, rendered as plain text. `labelKey` is only for
    // options MangoStudio itself recognizes by id, and none of these are.
    ...(typeof option.name === 'string' && option.name.length > 0 ? { rawLabel: option.name } : {}),
  };
}

/**
 * Plans one `session/request_permission`.
 *
 * A request with no usable option is refused rather than rendered: the neutral
 * contract requires at least one choice, and an approval card with no buttons
 * would block the turn on something nobody can answer. Refusing produces an
 * error frame, which unblocks the vendor immediately and shows up in its log
 * with the reason.
 */
function planCursorPermissionRequest(
  params: AcpRequestPermissionParams,
  requestId: string,
  nowMs: number
): CursorServerRequestPlan {
  const offered = params.options ?? [];
  const options = offered
    .map(toNeutralOption)
    .filter((option): option is ExternalApprovalOption => option !== undefined);

  if (options.length === 0 || options.length !== offered.length) {
    return {
      outcome: 'refuse',
      code: CURSOR_ERROR_CODES.invalidRequest,
      message:
        options.length === 0
          ? 'MangoStudio cannot present a permission request with no options.'
          : 'MangoStudio will not present a partial option set; every option needs an id.',
    };
  }

  // The neutral contract's own bounds, applied where the vendor's values enter
  // rather than where they are validated. Everything above is a shape this file
  // can refuse; these two are sizes, and a size the contract cannot carry is
  // rejected by the supervisor *after* the event is emitted — which ends the
  // turn rather than this one request. Refusing here costs the user an
  // unanswerable approval; not refusing costs them the turn.
  if (options.length > EXTERNAL_APPROVAL_MAX_OPTIONS) {
    return {
      outcome: 'refuse',
      code: CURSOR_ERROR_CODES.invalidRequest,
      message: `MangoStudio cannot present more than ${EXTERNAL_APPROVAL_MAX_OPTIONS} options for one permission request.`,
    };
  }
  // Ids travel to the client and come back to be echoed to the vendor, so a
  // shortened one would answer a different question. `requestId` is in the same
  // position: it is the vendor's own JSON-RPC id, stringified. The predicate is
  // `safeVendorId`'s own — anything it would reject downstream is refused here,
  // where the answer is still a refusal rather than a dead turn.
  if (
    !isCarryableVendorId(requestId) ||
    !options.every((option) => isCarryableVendorId(option.id))
  ) {
    return {
      outcome: 'refuse',
      code: CURSOR_ERROR_CODES.invalidRequest,
      message: `MangoStudio cannot carry a permission request or option id past ${EXTERNAL_TEXT_LIMITS.vendorId} characters.`,
    };
  }

  const toolCall = params.toolCall;
  const kind: ExternalActivityKind = activityKindFor(toolCall?.kind);
  const detail = toolCallDetail(toolCall?.content, toolCall?.rawInput);

  return {
    outcome: 'approval',
    ...(typeof params.sessionId === 'string' && params.sessionId.length > 0
      ? { nativeSessionId: params.sessionId }
      : {}),
    request: {
      requestId,
      kind,
      title: toolCallTitle(toolCall),
      ...detailFields(detail),
      options,
      expiresAtMs: nowMs + CURSOR_APPROVAL_TTL_MS,
    },
    encode(optionId) {
      if (!options.some((candidate) => candidate.id === optionId)) {
        throw new Error(`"${optionId}" is not an option Cursor offered for this approval.`);
      }
      return { outcome: { outcome: 'selected', optionId } };
    },
  };
}

/**
 * The complete client-method table, with the fallthrough that matters most.
 *
 * Any server→client method not listed is refused rather than ignored. An
 * unanswered request leaves the vendor blocked on a reply that never comes, so
 * "unknown" has to produce an error frame, not silence.
 *
 * The refusals are as load-bearing as the approval. `fs/read_text_file`,
 * `fs/write_text_file` and the `terminal/*` family are ACP asking **the client**
 * to touch the machine on the agent's behalf — MangoStudio's own tool surface,
 * reached through a vendor's protocol. This client advertises none of those
 * capabilities at `initialize`, and refusing them here is what makes that
 * advertisement true rather than polite. Cursor's own extension methods
 * (`cursor/update_todos`, `cursor/task`, `cursor/generate_image`) are refused
 * for the same reason: nothing outside the portable ACP core is promoted into
 * the shared contract.
 */
export function planCursorServerRequest(
  method: string,
  params: unknown,
  requestId: string,
  nowMs: number
): CursorServerRequestPlan {
  if (method === 'session/request_permission') {
    // JSON-RPC lets a request omit `params` entirely. Reading through the cast
    // would throw inside the request handler, and a handler that throws answers
    // nothing — leaving the vendor blocked on a reply that never comes, which is
    // the one outcome every refusal here exists to avoid.
    if (params === null || typeof params !== 'object') {
      return {
        outcome: 'refuse',
        code: CURSOR_ERROR_CODES.invalidRequest,
        message: 'MangoStudio cannot read a permission request without parameters.',
      };
    }
    return planCursorPermissionRequest(params as AcpRequestPermissionParams, requestId, nowMs);
  }
  if (method.startsWith('fs/') || method.startsWith('terminal/')) {
    return {
      outcome: 'refuse',
      code: CURSOR_ERROR_CODES.methodNotSupported,
      message:
        'MangoStudio hosts Cursor; it does not read, write or run anything on its behalf. External agents use their own tools.',
    };
  }
  return {
    outcome: 'refuse',
    code: CURSOR_ERROR_CODES.methodNotSupported,
    message: `MangoStudio does not implement the "${method}" client method.`,
  };
}
