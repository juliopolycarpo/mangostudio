/**
 * The one place a neutral external event becomes an SSE chunk.
 *
 * It lives in shared rather than in the streaming route because two consumers
 * have to agree about it exactly: the hub, which produces the chunks, and the
 * frontend reducer, which rebuilds message parts from them. The durable record
 * is built by the hub's transcript from the *same* neutral events, so any
 * difference between this mapping and that one shows up as a live render that
 * changes the moment the page is reloaded — the classic defect in a feature that
 * streams and persists the same thing twice.
 *
 * Keeping the function here lets one test drive both paths from a single event
 * sequence and compare the results, rather than trusting two switch statements
 * written weeks apart.
 *
 * Browser-safe: no Node builtins, directly or transitively.
 */

import type {
  ExternalAgentEvent,
  ExternalAgentTargetId,
  ExternalSteerRejectionReason,
  ExternalTurnTerminalReason,
} from '../external-agents/schemas';
import type { StreamChunk } from './events';

/** What the hub knows about a session once the runtime has opened one. */
export interface ExternalStreamSession {
  /** Hub-minted, not the vendor's own handle. */
  readonly sessionId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly resumed: boolean;
  readonly fallbackReason?: string;
}

/**
 * Announces how the turn ended, with the same value the durable record keeps.
 *
 * `done` says the stream is over; this says why. Without it a live view could
 * only ever show the vendor's own two outcomes, and reloading the page would
 * replace them with one of the hub's seven — a turn whose explanation changes
 * when the user refreshes.
 */
export function externalTurnCompletedChunk(reason: ExternalTurnTerminalReason): StreamChunk {
  return { type: 'external_turn_completed', reason, done: false };
}

/** Announces the session a turn is running in, before any vendor output. */
export function externalSessionStartedChunk(session: ExternalStreamSession): StreamChunk {
  return {
    type: 'external_session_started',
    sessionId: session.sessionId,
    targetId: session.targetId,
    resumed: session.resumed,
    ...(session.fallbackReason !== undefined ? { fallbackReason: session.fallbackReason } : {}),
    done: false,
  };
}

/**
 * Announces the resolved outcome of a mid-turn steer, live.
 *
 * Hub-originated, like {@link externalSessionStartedChunk}: steering is the
 * user talking to the running turn, not something the vendor reported, so
 * there is no {@link ExternalAgentEvent} to project it from.
 */
export function externalSteerChunk(
  input:
    | { readonly clientMessageId: string; readonly text: string; readonly status: 'accepted' }
    | {
        readonly clientMessageId: string;
        readonly text: string;
        readonly status: 'rejected';
        readonly reasonCode: ExternalSteerRejectionReason;
      }
): StreamChunk {
  if (input.status === 'rejected') {
    return {
      type: 'external_steer',
      clientMessageId: input.clientMessageId,
      text: input.text,
      status: 'rejected',
      reasonCode: input.reasonCode,
      done: false,
    };
  }
  return {
    type: 'external_steer',
    clientMessageId: input.clientMessageId,
    text: input.text,
    status: 'accepted',
    done: false,
  };
}

/**
 * Projects one neutral event onto the wire.
 *
 * `null` means the event has no chunk of its own, not that it was dropped:
 *
 * - `session_started` carries the vendor's resumable handle and is announced
 *   instead through {@link externalSessionStartedChunk} with the hub's id.
 * - `completed` is one of nine ways a turn ends, and the hub decides seven of
 *   them, so the terminal state is announced once through
 *   {@link externalTurnCompletedChunk} instead of twice with different
 *   vocabularies.
 */
export function externalAgentEventToStreamChunk(event: ExternalAgentEvent): StreamChunk | null {
  switch (event.type) {
    case 'session_started':
    case 'completed':
      return null;

    case 'text_delta':
      return { type: 'external_text', text: event.text, done: false };

    case 'reasoning_delta':
      return { type: 'external_reasoning', text: event.text, done: false };

    case 'activity_started':
      return {
        type: 'external_activity_started',
        callId: event.callId,
        name: event.activity.name,
        kind: event.activity.kind,
        title: event.activity.title,
        ...(event.activity.detail !== undefined ? { detail: event.activity.detail } : {}),
        ...(event.activity.truncated ? { truncated: true } : {}),
        done: false,
      };

    case 'activity_updated':
      return {
        type: 'external_activity_updated',
        callId: event.callId,
        update: event.update,
        done: false,
      };

    case 'activity_completed':
      return {
        type: 'external_activity_completed',
        callId: event.callId,
        status: event.result.status,
        ...(event.result.detail !== undefined ? { detail: event.result.detail } : {}),
        // Derived here rather than by the reducer so the flag comes from the
        // same rule the persisted part is built with.
        ...(event.result.status === 'failed' ? { isError: true } : {}),
        ...(event.result.truncated ? { truncated: true } : {}),
        done: false,
      };

    case 'approval_requested':
      return {
        type: 'external_approval_request',
        requestId: event.request.requestId,
        kind: event.request.kind,
        title: event.request.title,
        ...(event.request.detail !== undefined ? { detail: event.request.detail } : {}),
        options: [...event.request.options],
        expiresAtMs: event.request.expiresAtMs,
        ...(event.request.truncated ? { truncated: true } : {}),
        done: false,
      };

    case 'approval_resolved':
      return {
        type: 'external_approval_status',
        requestId: event.requestId,
        decision: event.decision,
        done: false,
      };

    case 'usage':
      return { type: 'external_usage', usage: event.usage, done: false };

    case 'thread_usage':
      return { type: 'external_thread_usage', usage: event.usage, done: false };

    case 'account_limits':
      return { type: 'external_account_limits', limits: event.limits, done: false };

    case 'error':
      return { type: 'external_error', error: event.error, done: false };
  }
}
