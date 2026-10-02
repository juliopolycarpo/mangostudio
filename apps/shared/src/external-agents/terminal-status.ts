import type { ExternalActivityStatus, ExternalTurnTerminalReason } from './schemas';

const ACTIVITY_STATUS_BY_TERMINAL_REASON = {
  completed: 'completed',
  'cancelled-by-user': 'cancelled',
  interrupted: 'cancelled',
  'vendor-error': 'failed',
  'runtime-disconnected': 'failed',
  'hub-restarted': 'failed',
  'sequence-gap': 'failed',
  'limit-exceeded': 'failed',
  'consent-revoked': 'cancelled',
  'session-lost': 'failed',
  'acceptance-unknown': 'failed',
} satisfies Record<ExternalTurnTerminalReason, ExternalActivityStatus>;

/**
 * Settles an activity whose vendor close was omitted using its turn's outcome.
 * Both the live view and persisted transcript use this mapping; callers keep
 * any explicit activity result instead of replacing it with the fallback.
 *
 * @example externalActivityStatusForTerminal('cancelled-by-user'); // 'cancelled'
 */
export function externalActivityStatusForTerminal(
  reason: ExternalTurnTerminalReason
): ExternalActivityStatus {
  return ACTIVITY_STATUS_BY_TERMINAL_REASON[reason];
}
