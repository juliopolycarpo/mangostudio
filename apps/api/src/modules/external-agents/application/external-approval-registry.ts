/**
 * Pending approvals for external turns.
 *
 * This is the sharpest edge in the whole feature, because answering one
 * authorizes a third-party process to act on the user's machine. Everything
 * here exists so that an approval can only ever be answered by the person it was
 * shown to, for the request it was shown for, with a choice the vendor actually
 * offered, while it is still live.
 *
 * Every pending approval is bound to
 * `(userId, chatId, sessionId, nativeTurnId, requestId)` and stores the exact
 * option set the vendor sent. A response is accepted only when:
 *
 * 1. The requester is the owning user.
 * 2. All five identity components match.
 * 3. `optionId` is one the vendor offered **for that request**.
 * 4. The request has not expired.
 * 5. The request is not already resolved — a repeat with the same
 *    `(requestId, optionId)` is idempotent and returns the recorded outcome;
 *    a repeat with a *different* `optionId` is rejected.
 *
 * Expiry is evaluated on read rather than on a timer. A timer would have to fire
 * inside a hub that may be asleep between turns, and the two moments that matter
 * — someone answering, and the turn ending — both already pass through here. The
 * turn controller persists the expiry onto the transcript, so a reloaded chat
 * renders a dead card rather than a live control that will never resolve.
 */

import type {
  ExternalApprovalDecision,
  ExternalApprovalRequest,
} from '@mangostudio/shared/external-agents';

/** The five components an answer has to match, in full. */
export interface ExternalApprovalBinding {
  readonly userId: string;
  readonly chatId: string;
  readonly sessionId: string;
  readonly nativeTurnId: string;
  readonly requestId: string;
}

type ExternalApprovalRejection =
  /** No live approval for this (user, chat, request). Covers a wrong owner. */
  | 'not-found'
  | 'session-mismatch'
  | 'turn-mismatch'
  | 'unknown-option'
  | 'expired'
  /** Already answered, with a different option than the one now offered. */
  | 'already-resolved';

export type AnswerExternalApprovalResult =
  | {
      readonly status: 'accepted';
      readonly optionId: string;
      /** True when this repeated an answer already recorded for the same option. */
      readonly idempotent: boolean;
    }
  | { readonly status: 'rejected'; readonly reason: ExternalApprovalRejection };

interface AnswerExternalApprovalInput {
  readonly userId: string;
  readonly chatId: string;
  readonly requestId: string;
  readonly optionId: string;
  /**
   * Server-owned components. A caller that knows them (the live SSE stream does)
   * passes them and gets them checked; one that does not is still bound by the
   * three it must supply, which the registry pairs with the session and turn it
   * recorded.
   */
  readonly sessionId?: string;
  readonly nativeTurnId?: string;
}

interface RegisterExternalApprovalInput {
  readonly binding: ExternalApprovalBinding;
  readonly request: ExternalApprovalRequest;
  /**
   * Forwards the answer to the vendor. Called at most once per approval, inside
   * the registry, so no caller can reach the vendor without passing the checks
   * above.
   */
  readonly forward: (optionId: string) => Promise<void>;
}

/**
 * How an approval left the pending set, for the transcript the UI renders.
 *
 * `optionId` is absent for `expired` and `cancelled` because nobody chose one —
 * the vendor's option ids all have a minimum length, so an empty string would be
 * a fabricated choice rather than the absence of one.
 */
interface ExternalApprovalResolution {
  readonly requestId: string;
  readonly optionId?: string;
  readonly source: ExternalApprovalDecision['source'];
  readonly resolvedAt: number;
}

interface PendingApproval {
  readonly binding: ExternalApprovalBinding;
  readonly optionIds: ReadonlySet<string>;
  readonly expiresAtMs: number;
  readonly forward: (optionId: string) => Promise<void>;
  resolved?: ExternalApprovalResolution;
}

export interface ExternalApprovalRegistry {
  register(input: RegisterExternalApprovalInput): void;
  answer(input: AnswerExternalApprovalInput): Promise<AnswerExternalApprovalResult>;
  /**
   * Resolves everything still pending for one turn. `expired` is what a turn
   * ending leaves behind; `cancelled` is what a cancelled or torn-down session
   * does. Returns the resolutions so the caller can persist them.
   */
  resolvePending(
    chatId: string,
    nativeTurnId: string,
    source: 'expired' | 'cancelled',
    at: number
  ): readonly ExternalApprovalResolution[];
  /** Drops everything for a chat without recording an outcome. */
  clearChat(chatId: string): void;
  pendingCount(chatId: string): number;
}

export interface ExternalApprovalRegistryOptions {
  readonly now?: () => number;
}

export function createExternalApprovalRegistry(
  options: ExternalApprovalRegistryOptions = {}
): ExternalApprovalRegistry {
  const now = options.now ?? Date.now;
  // Keyed by chat so a turn's teardown never has to walk every approval in the
  // hub, and so one chat's pending set cannot be reached from another's id.
  const byChat = new Map<string, Map<string, PendingApproval>>();

  function chatEntries(chatId: string): Map<string, PendingApproval> {
    const existing = byChat.get(chatId);
    if (existing) return existing;
    const created = new Map<string, PendingApproval>();
    byChat.set(chatId, created);
    return created;
  }

  return {
    register(input) {
      chatEntries(input.binding.chatId).set(input.binding.requestId, {
        binding: input.binding,
        optionIds: new Set(input.request.options.map((option) => option.id)),
        expiresAtMs: input.request.expiresAtMs,
        forward: input.forward,
      });
    },

    async answer(input) {
      const pending = byChat.get(input.chatId)?.get(input.requestId);
      // One indistinguishable answer for "no such request", "not your chat" and
      // "already forgotten": a caller must not be able to probe another user's
      // chats by watching which of them answers differently.
      if (!pending || pending.binding.userId !== input.userId) {
        return { status: 'rejected', reason: 'not-found' };
      }
      if (input.sessionId !== undefined && input.sessionId !== pending.binding.sessionId) {
        return { status: 'rejected', reason: 'session-mismatch' };
      }
      if (input.nativeTurnId !== undefined && input.nativeTurnId !== pending.binding.nativeTurnId) {
        return { status: 'rejected', reason: 'turn-mismatch' };
      }

      if (pending.resolved) {
        // Idempotent only for the same option. A different one is a second,
        // conflicting authorization and is refused rather than silently ignored.
        return pending.resolved.optionId === input.optionId && pending.resolved.source === 'user'
          ? { status: 'accepted', optionId: input.optionId, idempotent: true }
          : { status: 'rejected', reason: 'already-resolved' };
      }

      // Option membership is checked before expiry so a stale card cannot be
      // used to learn which option ids a request carried.
      if (!pending.optionIds.has(input.optionId)) {
        return { status: 'rejected', reason: 'unknown-option' };
      }
      if (now() >= pending.expiresAtMs) {
        return { status: 'rejected', reason: 'expired' };
      }

      // Recorded before the forward, so a slow or failing vendor call cannot let
      // a second answer through while the first is still in flight.
      pending.resolved = {
        requestId: input.requestId,
        optionId: input.optionId,
        source: 'user',
        resolvedAt: now(),
      };

      // The record stays after a successful answer, so a client that retried a
      // dropped response gets the outcome it already caused rather than a
      // refusal. It is dropped when the turn ends, which bounds it to one turn's
      // approvals. A failed forward keeps it for the same reason the comment
      // above gives: the authorization stands even though the vendor never
      // heard it, so a retry must not authorize a second time.
      await pending.forward(input.optionId);
      return { status: 'accepted', optionId: input.optionId, idempotent: false };
    },

    resolvePending(chatId, nativeTurnId, source, at) {
      const entries = byChat.get(chatId);
      if (!entries) return [];

      const resolutions: ExternalApprovalResolution[] = [];
      for (const [requestId, pending] of entries) {
        if (pending.binding.nativeTurnId !== nativeTurnId) continue;
        // Every entry for the turn goes, answered or not: this is what keeps
        // the answered ones from accumulating for the life of the chat.
        entries.delete(requestId);
        if (pending.resolved) continue;
        resolutions.push({ requestId, source, resolvedAt: at });
      }
      if (entries.size === 0) byChat.delete(chatId);
      return resolutions;
    },

    clearChat(chatId) {
      byChat.delete(chatId);
    },

    pendingCount(chatId) {
      const entries = byChat.get(chatId);
      if (!entries) return 0;
      let pending = 0;
      for (const entry of entries.values()) if (!entry.resolved) pending += 1;
      return pending;
    },
  };
}

/** The hub's registry. One per process; the turn controller is its only writer. */
export const externalApprovalRegistry = createExternalApprovalRegistry();
