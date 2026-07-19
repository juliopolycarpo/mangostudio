import type { TurnInterruptionReasonCode } from '@mangostudio/shared/turn-recovery';

interface ActiveTurn {
  readonly userId: string;
  readonly chatId: string;
  readonly abort: (reasonCode: TurnInterruptionReasonCode) => void;
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
