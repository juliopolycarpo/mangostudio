/**
 * How full an external agent's context window is, from what its vendor
 * reported.
 *
 * The two token scopes a vendor reports are not interchangeable here. `total`
 * is cumulative over the whole thread — it passes the window's size after a
 * few turns and keeps climbing, so a percentage built on it would read 400%
 * on a chat that is nowhere near full. `last` is the most recent request the
 * vendor made, whose prompt *is* the context it is carrying, so that is the
 * numerator.
 */

import { type ContextSeverity, getContextSeverity } from '../chat/context-severity';
import type { ExternalThreadUsage, ExternalUsage } from './schemas';

export interface ExternalContextUsage {
  /** Tokens the last request carried, as reported. */
  readonly usedTokens: number;
  /** The vendor's window for the active model. */
  readonly windowTokens: number;
  /** `usedTokens / windowTokens`, clamped to 0–1. */
  readonly ratio: number;
  /** `ratio` as whole percent, for display. */
  readonly percent: number;
  readonly severity: ContextSeverity;
}

/**
 * The one figure that stands for a usage scope, or `null` if the vendor
 * reported nothing countable — which is not the same as zero.
 *
 * A sparse report means only that a field went unreported. Summing input and
 * output is the fallback rather than the rule: a vendor that reports its own
 * `totalTokens` may count cache reads or reasoning in ways the two visible
 * fields do not add up to, and its own figure is the one to trust.
 */
export function externalReportedTokens(usage: ExternalUsage): number | null {
  if (usage.totalTokens !== undefined) return usage.totalTokens;
  if (usage.inputTokens === undefined && usage.outputTokens === undefined) return null;
  return (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
}

/** `null` whenever either half of the fraction is missing — never a guessed window. */
export function externalContextUsage(
  usage: ExternalThreadUsage | null | undefined
): ExternalContextUsage | null {
  const windowTokens = usage?.contextWindowTokens;
  if (!usage?.last || windowTokens === undefined || windowTokens <= 0) return null;

  const usedTokens = externalReportedTokens(usage.last);
  if (usedTokens === null) return null;

  const ratio = Math.min(1, Math.max(0, usedTokens / windowTokens));
  return {
    usedTokens,
    windowTokens,
    ratio,
    percent: Math.round(ratio * 100),
    severity: getContextSeverity(ratio),
  };
}
