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
import { interpretExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { useApp } from '@/lib/app-context';
import { describeAccountLimits, nextAccountLimitsCopyChangeMs } from './account-limits-copy';
import { useExternalAccountLimits } from './use-external-account-limits';
import { useExternalAgents } from './useExternalAgents';

export function HeaderQuotaPill() {
  const app = useApp();
  const external = useExternalAgents(app.currentEnvironmentId);
  const runner = app.runner;
  const descriptor = (runner.kind === 'external' && external.find(runner.targetId)) || null;
  const quotaDescriptor = descriptor?.capabilities.accountUsage ? descriptor : null;
  const { limits, refreshing, refresh } = useExternalAccountLimits(quotaDescriptor);
  const nowMs = useQuotaClock(limits);

  if (!quotaDescriptor) return null;
  return (
    <QuotaPillView limits={limits} nowMs={nowMs} refreshing={refreshing} onRefresh={refresh} />
  );
}

/**
 * `Date.now()` for the render, plus the re-renders the copy needs to stay true.
 *
 * Everything this pill says is a clock comparison, so a tab left open drifts
 * away from it with nothing to notice: the snapshot goes stale, and an exhausted
 * window's reset arrives and passes, while the header keeps whatever sentence it
 * last rendered. One `setTimeout` armed for the next moment the copy changes
 * closes that.
 *
 * Still not a poll. Each wake arms the next one, every wake is a moment the
 * words on screen actually change, and the whole chain ends at the staleness
 * deadline — so the busiest case, a minute-by-minute countdown, is bounded by
 * the fifteen minutes a snapshot is worth reading at all.
 */
function useQuotaClock(limits: ExternalAccountLimits | null | undefined): number {
  const [, setTicks] = useState(0);
  const nowMs = Date.now();
  const wakeAtMs = nextAccountLimitsCopyChangeMs(limits, nowMs);

  useEffect(() => {
    if (wakeAtMs === undefined) return;
    // Re-read the clock: `wakeAtMs` was computed a render ago, and `Math.max`
    // turns that drift into an immediate wake rather than a negative delay.
    const timer = setTimeout(
      () => setTicks((count) => count + 1),
      Math.max(0, wakeAtMs - Date.now())
    );
    return () => clearTimeout(timer);
  }, [wakeAtMs]);

  return nowMs;
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
