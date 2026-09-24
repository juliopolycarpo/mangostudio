/**
 * What happens to an external turn the hub stopped watching.
 *
 * A row with `isGenerating = 1` and no live registration is the failure that
 * bites in practice: the transcript spins forever, and the next reconcile pass
 * re-reads it every time. The internal turn's sweep already clears such rows,
 * but it clears them as `unknown` — it has no way to know an external turn ended
 * because the hub went away, and no place to write it if it did.
 *
 * So external turns get their own pass, running **before** the generic one, and
 * it records the reason on the turn's own record. Approvals left pending are
 * sealed at the same time: an approval whose hub restarted is not going to be
 * answered, and a card that says otherwise is a lie the user can click.
 *
 * This runs at boot and nowhere else, deliberately. `hub-restarted` is only
 * honest about a hub that is starting up; a periodic sweep would have to name a
 * reason for a turn whose controller vanished while the hub kept running, and
 * every member of the closed set would be a claim nothing here can support.
 * During normal operation the controller finalizes its own turn.
 */

import type { ExternalTurnTerminalReason } from '@mangostudio/shared/external-agents';
import type { ExternalTurnPart, MessagePart } from '@mangostudio/shared/types';
import type { Kysely } from 'kysely';
import type { Database, ExternalTurnAttemptSelect } from '../../../db/types';
import {
  listAttemptsForMessage,
  sealAttemptsForMessage,
} from '../infrastructure/external-turn-attempt-repository';

export interface ReconcileExternalTurnsInput {
  readonly reason: ExternalTurnTerminalReason;
  /** Nothing can be live at boot; the guard exists so a caller can prove it. */
  readonly isActive?: (messageId: string) => boolean;
  readonly chatId?: string;
  /** One turn, for a caller acting on a message it already identified. */
  readonly messageId?: string;
  readonly now?: () => number;
}

/** Number of external turns reconciled. */
export async function reconcileExternalTurns(
  input: ReconcileExternalTurnsInput,
  db: Kysely<Database>
): Promise<number> {
  const at = (input.now ?? Date.now)();
  let query = db
    .selectFrom('messages')
    .select(['id', 'parts'])
    .where('role', '=', 'ai')
    .where('isGenerating', '=', 1);
  if (input.chatId) query = query.where('chatId', '=', input.chatId);
  if (input.messageId) query = query.where('id', '=', input.messageId);

  const rows = await query.execute();
  let reconciled = 0;

  for (const row of rows) {
    if (input.isActive?.(row.id)) continue;
    const parts = parseParts(row.parts);
    const turnPart = parts.find(isExternalTurnPart);
    // Not an external turn: the generic sweep owns it, and clearing it here
    // would take away the reason it records.
    if (!turnPart) continue;

    // A turn can be recorded terminal a moment before its final update clears
    // `isGenerating`; a crash in that window leaves a message that says it
    // finished and renders as still running. Clear the flag, keep the reason
    // the turn actually ended for.
    const attempts = await listAttemptsForMessage(row.id, db);
    if (turnPart.status !== 'terminal') {
      turnPart.status = 'terminal';
      turnPart.terminalReason = reasonFromAttempts(input.reason, attempts);
      turnPart.updatedAt = at;
    }
    sealPendingApprovals(parts, at);

    const result = await db
      .updateTable('messages')
      .set({ parts: JSON.stringify(parts), isGenerating: 0 })
      .where('id', '=', row.id)
      .where('isGenerating', '=', 1)
      .executeTakeFirst();
    if (result.numUpdatedRows > 0n) reconciled += 1;
    await sealAttemptsForMessage(row.id, turnPart.terminalReason ?? input.reason, at, db);
  }

  return reconciled;
}

/**
 * Seals every submission receipt still open whose turn is no longer
 * generating — a hub that died between finalizing a turn and sealing its
 * receipts leaves exactly these, and the message sweep above never visits
 * them because their message is already done. Boot only, for the reason
 * {@link reconcileExternalTurns} gives. Returns the number of turns touched.
 *
 * @example
 * await sealOrphanedExternalTurnAttempts(getDb());
 */
export async function sealOrphanedExternalTurnAttempts(
  db: Kysely<Database>,
  now: () => number = Date.now
): Promise<number> {
  const rows = await db
    .selectFrom('external_turn_attempts')
    .leftJoin('messages', 'messages.id', 'external_turn_attempts.messageId')
    .select(['external_turn_attempts.messageId as messageId', 'messages.parts as parts'])
    .where('external_turn_attempts.state', 'in', [
      'acceptance-unknown',
      'not-submitted',
      'accepted',
    ])
    .where((eb) => eb.or([eb('messages.id', 'is', null), eb('messages.isGenerating', '=', 0)]))
    .distinct()
    .execute();
  const at = now();
  for (const row of rows) {
    const recorded = parseParts(row.parts).find(isExternalTurnPart)?.terminalReason;
    await sealAttemptsForMessage(row.messageId, recorded ?? 'hub-restarted', at, db);
  }
  return rows.length;
}

/**
 * What a restart may honestly say about a turn, given its submission receipts.
 *
 * Only the boot pass consults them: an explicit reason (the user's own cancel)
 * already says why the turn ended. At boot, a turn whose latest attempt was
 * still `acceptance-unknown` (or already `unresolved`) was sent and never confirmed — calling that
 * `hub-restarted` would imply the vendor had it. An accepted turn did run, and
 * one only ever `not-submitted` never reached the vendor; both are what
 * `hub-restarted` means, and neither is resubmitted.
 */
function reasonFromAttempts(
  reason: ExternalTurnTerminalReason,
  attempts: readonly ExternalTurnAttemptSelect[]
): ExternalTurnTerminalReason {
  if (reason !== 'hub-restarted') return reason;
  const latest = attempts.at(-1);
  // `unresolved` too: the submission already concluded the acceptance was
  // unknowable, and the hub died before the turn could say so.
  return latest?.state === 'acceptance-unknown' || latest?.state === 'unresolved'
    ? 'acceptance-unknown'
    : reason;
}

function isExternalTurnPart(part: MessagePart): part is ExternalTurnPart {
  return part.type === 'external_turn';
}

function sealPendingApprovals(parts: MessagePart[], at: number): void {
  for (const part of parts) {
    if (part.type !== 'external_approval' || part.decisionSource !== undefined) continue;
    part.decisionSource = 'expired';
    part.resolvedAt = at;
  }
}

function parseParts(raw: string | null): MessagePart[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as MessagePart[]) : [];
  } catch {
    return [];
  }
}
