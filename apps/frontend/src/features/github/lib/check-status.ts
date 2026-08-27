/**
 * Reducing a pull request's check counters to the one word a chip has room for.
 *
 * Shared by the rail panel's rows and the Repository panel's branch chip so the
 * two never disagree about whether a pull request is green.
 */

import type { GithubCheckSummary } from '@mangostudio/shared/github';
import type { Messages } from '@mangostudio/shared/i18n';

/** Which `github.chip.*` sentence a summary earns, plus the tone to paint it. */
export interface CheckChipStatus {
  readonly labelKey: keyof Messages['github']['chip'];
  readonly tone: 'success' | 'warning' | 'error' | 'neutral';
}

/**
 * Failure beats pending beats success, because that is the order somebody acts
 * on them: a red run is worth interrupting for, a running one is worth waiting
 * for, and a green one is worth nothing at all.
 *
 * A null summary is "this pull request has no CI"; a summary whose `total` is
 * zero is a rollup that came back empty for a repository that *does* run
 * checks. Both read as "no checks" to a chip, but they arrive differently and
 * the caller keeps the distinction.
 *
 * @example
 * checkChipStatus({ passed: 3, failed: 1, pending: 0, total: 4 }).labelKey; // 'checksFailing'
 */
export function checkChipStatus(summary: GithubCheckSummary | null): CheckChipStatus {
  if (!summary || summary.total === 0) return { labelKey: 'noChecks', tone: 'neutral' };
  if (summary.failed > 0) return { labelKey: 'checksFailing', tone: 'error' };
  if (summary.pending > 0) return { labelKey: 'checksRunning', tone: 'warning' };
  return { labelKey: 'checksPassing', tone: 'success' };
}
