/**
 * The header's quota readout for an external runner.
 *
 * Quiet while the account has room, a warning badge once the snapshot is stale
 * or the tightest window is exhausted — the two states where the user's next
 * turn may bounce and the fix (refresh, or wait for the reset) is theirs to
 * take. Clicking is the refresh. Renders nothing for MangoStudio runners and
 * for vendors that report no account usage.
 */

import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import {
  EXTERNAL_ACCOUNT_LIMITS_STALE_MS,
  interpretExternalAccountLimits,
} from '@mangostudio/shared/external-agents';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { describeAccountLimits } from './account-limits-copy';
import { useExternalAccountLimits } from './use-external-account-limits';
import { useExternalAgents } from './useExternalAgents';

export function HeaderQuotaPill() {
  const app = useApp();
  const external = useExternalAgents(app.currentEnvironmentId);
  const runner = app.runner;
  const descriptor = (runner.kind === 'external' && external.find(runner.targetId)) || null;
  const quotaDescriptor = descriptor?.capabilities.accountUsage ? descriptor : null;
  const { limits, refreshing, refresh } = useExternalAccountLimits(quotaDescriptor);
  const nowMs = useFreshnessDeadline(limits?.observedAtMs);

  if (!quotaDescriptor) return null;
  return (
    <QuotaPillView limits={limits} nowMs={nowMs} refreshing={refreshing} onRefresh={refresh} />
  );
}

/**
 * `Date.now()` for the render, plus the one re-render that the deadline needs.
 *
 * Freshness is a clock comparison, so a tab left open crosses the threshold with
 * nothing to notice it: the pill would keep claiming a quota it no longer knows
 * until something unrelated re-rendered the header. One `setTimeout` armed for
 * the exact moment the snapshot expires closes that, and it is still not a poll
 * — it fires once per snapshot, and the next snapshot arms the next one.
 */
function useFreshnessDeadline(observedAtMs: number | undefined): number {
  const [, setExpiries] = useState(0);

  useEffect(() => {
    if (observedAtMs === undefined) return;
    // `+ 1`: the verdict flips on *strictly* older than the window, so waking on
    // the boundary itself would re-render to the same answer and never wake again.
    const delay = observedAtMs + EXTERNAL_ACCOUNT_LIMITS_STALE_MS + 1 - Date.now();
    if (delay <= 0) return;
    const timer = setTimeout(() => setExpiries((count) => count + 1), delay);
    return () => clearTimeout(timer);
  }, [observedAtMs]);

  return Date.now();
}

export function QuotaPillView({
  limits,
  nowMs = Date.now(),
  onRefresh,
  refreshing,
}: {
  limits: ExternalAccountLimits | null | undefined;
  nowMs?: number;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.limits;
  const verdict = interpretExternalAccountLimits(limits, nowMs);

  // Loading and "vendor never answered" look the same, and neither deserves
  // chrome: a pill that says "quota unknown" all day is noise, not a warning.
  if (verdict.kind === 'unknown') return null;

  const { body, low } = describeAccountLimits(verdict, labels, nowMs);
  // Stale escalates here where it does not in the selector's chip: this pill is
  // the only quota readout on screen, so "we no longer know" is the state the
  // user has to act on rather than one the surrounding row already explains.
  const variant: 'neutral' | 'warning' = verdict.kind === 'stale' || low ? 'warning' : 'neutral';

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      title={labels.refresh}
      data-testid="header-quota-pill"
      data-verdict={verdict.kind}
      className="min-w-0 shrink-0 cursor-pointer disabled:cursor-default"
    >
      <Badge variant={variant} className="max-w-full gap-1.5 normal-case tracking-normal font-mono">
        <RefreshCw size={10} className={refreshing ? 'animate-spin' : undefined} />
        {/* Below `sm` the readout collapses to its icon and the badge's own
            colour, which is what the warning states are actually carrying — the
            longest body ("quota exhausted, resets in …") is wider than the space
            a 320px header has left after the runner pill and the controls. The
            words stay in the accessibility tree at every width. */}
        <span className="min-w-0 truncate max-sm:sr-only">{body}</span>
      </Badge>
    </button>
  );
}
