import type { ExternalAgentTargetId } from '@mangostudio/shared/external-agents';
import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';

/**
 * The server-owned identity of a live external turn.
 *
 * It hangs off the same registration as every other turn rather than living in
 * a parallel registry, so the stop button, the stale-row reconcile sweep and
 * turn recovery keep working on external turns without knowing what one is.
 */
export interface ActiveExternalTurn {
  readonly sessionId: string;
  readonly targetId: ExternalAgentTargetId;
  readonly environmentId: string;
  /** Absent only in the window between registering the turn and the vendor naming it. */
  nativeTurnId?: string;
}

interface ActiveTurn {
  readonly userId: string;
  readonly chatId: string;
  readonly abort: (reasonCode: TurnInterruptionReasonCode) => void;
  /** Present only for turns a vendor CLI is running. */
  readonly external?: ActiveExternalTurn;
}

/** What a caller may learn about a turn it did not start. */
export interface ActiveTurnSnapshot {
  readonly messageId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly external?: ActiveExternalTurn;
}

const activeTurns = new Map<string, ActiveTurn>();

/**
 * A row with isGenerating = 1 must never be observable while its live turn is
 * unregistered. Register the turn before inserting its assistant row.
 */
export function registerActiveTurn(messageId: string, turn: ActiveTurn): void {
  activeTurns.set(messageId, turn);
}

export function unregisterActiveTurn(messageId: string): void {
  activeTurns.delete(messageId);
}

export function isActiveTurn(messageId: string): boolean {
  return activeTurns.has(messageId);
}

/**
 * The chat's live turn, whoever runs it.
 *
 * A chat holds one turn at a time, and the check has to see internal and
 * external turns alike: a second send arriving while either is running is a
 * conflict, not a second vendor session.
 */
export function findActiveTurnByChat(chatId: string): ActiveTurnSnapshot | undefined {
  for (const [messageId, turn] of activeTurns) {
    if (turn.chatId !== chatId) continue;
    return {
      messageId,
      userId: turn.userId,
      chatId: turn.chatId,
      ...(turn.external ? { external: turn.external } : {}),
    };
  }
  return undefined;
}

export function cancelActiveTurn(
  messageId: string,
  userId: string,
  chatId: string,
  reasonCode: TurnInterruptionReasonCode
): boolean {
  const turn = activeTurns.get(messageId);
  if (!turn || turn.userId !== userId || turn.chatId !== chatId) return false;
  turn.abort(reasonCode);
  return true;
}
