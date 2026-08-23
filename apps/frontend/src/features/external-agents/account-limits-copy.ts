/**
 * The sentence a quota verdict reads as, shared by the selector's chip and the
 * header pill.
 *
 * Only the wording lives here. The two surfaces escalate differently — the chip
 * keeps a stale snapshot muted, the pill treats it as the thing worth a badge —
 * so each keeps its own tone mapping and takes `low` as the one shared input.
 */

import type {
  ExternalAccountLimits,
  ExternalAccountLimitsVerdict,
} from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_ACCOUNT_LIMITS_STALE_MS,
  interpretExternalAccountLimits,
} from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';

type LimitsLabels = Messages['externalAgents']['limits'];

/**
 * The countdown a reset reads as, in the active locale's units.
 *
 * Every suffix and the hours-minutes order come from the catalogue rather than
 * from a template literal here: an abbreviation is user-visible text, and a
 * locale that writes minutes as something other than `m` — or puts the smaller
 * unit first — has no way to say so otherwise.
 */
function formatCompactDuration(ms: number, labels: LimitsLabels): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes < 60) return labels.durationMinutes.replace('{count}', String(totalMinutes));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) {
    return minutes > 0
      ? labels.durationHoursMinutes
          .replace('{hours}', String(hours))
          .replace('{minutes}', String(minutes))
      : labels.durationHours.replace('{count}', String(hours));
  }
  const days = Math.floor(hours / 24);
  return labels.durationDays.replace('{count}', String(days));
}

export interface AccountLimitsCopy {
  body: string;
  /** The tightest window is exhausted or nearly so — the only escalation both surfaces agree on. */
  low: boolean;
}

export function describeAccountLimits(
  verdict: ExternalAccountLimitsVerdict,
  labels: LimitsLabels,
  nowMs: number
): AccountLimitsCopy {
  if (verdict.kind === 'unknown') return { body: labels.unknown, low: false };
  if (verdict.kind === 'stale') return { body: labels.stale, low: false };

  if (verdict.exhausted) {
    const resetsAtMs = verdict.tightest.resetsAtMs;
    const body =
      resetsAtMs !== undefined && resetsAtMs > nowMs
        ? `${labels.exhausted} · ${labels.resetsIn.replace(
            '{duration}',
            formatCompactDuration(resetsAtMs - nowMs, labels)
          )}`
        : labels.exhausted;
    return { body, low: true };
  }

  const remaining = Math.max(0, 100 - verdict.tightest.usedPercent);
  return {
    body: labels.remaining.replace('{percent}', String(Math.round(remaining))),
    low: remaining <= 15,
  };
}

/** Half a minute: `formatCompactDuration` rounds, so the number turns over here. */
const MINUTE_ROUNDING_OFFSET_MS = 30_000;

/**
 * When this copy next says something different on the clock alone, or
 * `undefined` when nothing more will change until new data arrives.
 *
 * Three things move with no new snapshot: the snapshot goes stale, an exhausted
 * window reaches its reset, and the countdown ticks down a minute. A caller that
 * armed only the staleness deadline would leave "resets in 1m" on screen for the
 * quarter hour after that reset actually passed — which is the one moment the
 * user is watching the pill for.
 *
 * Always strictly in the future, so a caller can arm a timer on it without
 * risking a wake that computes the same answer and never wakes again.
 */
export function nextAccountLimitsCopyChangeMs(
  limits: ExternalAccountLimits | null | undefined,
  nowMs: number
): number | undefined {
  if (!limits) return undefined;
  // `+ 1`: staleness flips on *strictly* older than the window.
  const staleAtMs = limits.observedAtMs + EXTERNAL_ACCOUNT_LIMITS_STALE_MS + 1;
  // Past the deadline the copy is the single word "stale" — nothing left to wake for.
  if (staleAtMs <= nowMs) return undefined;

  const verdict = interpretExternalAccountLimits(limits, nowMs);
  const resetsAtMs =
    verdict.kind === 'ok' && verdict.exhausted ? verdict.tightest.resetsAtMs : undefined;
  if (resetsAtMs === undefined || resetsAtMs <= nowMs) return staleAtMs;

  const shownMinutes = Math.round((resetsAtMs - nowMs) / 60_000);
  const nextTickMs = resetsAtMs - (shownMinutes * 60_000 - MINUTE_ROUNDING_OFFSET_MS);
  // Standing exactly on a boundary rounds up, so the shown number is already one
  // instant from turning over; `nowMs + 1` is that instant.
  return Math.min(staleAtMs, resetsAtMs, Math.max(nextTickMs, nowMs + 1));
}
