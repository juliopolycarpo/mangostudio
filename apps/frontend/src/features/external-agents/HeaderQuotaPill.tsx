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
import { formatCompactDuration } from './ExternalAccountLimitsChip';
import { useExternalAccountLimits } from './use-external-account-limits';
import { useExternalAgents } from './useExternalAgents';

export function HeaderQuotaPill() {
  const app = useApp();
  const external = useExternalAgents(app.currentEnvironmentId);
  const runner = app.runner;
  const descriptor = (runner.kind === 'external' && external.find(runner.targetId)) || null;
  const { limits, refreshing, refresh } = useExternalAccountLimits(descriptor);
  const nowMs = useFreshnessDeadline(limits?.observedAtMs);

  if (!descriptor?.capabilities.accountUsage) return null;
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

  let body: string;
  let variant: 'neutral' | 'warning' = 'neutral';
  if (verdict.kind === 'stale') {
    body = labels.stale;
    variant = 'warning';
  } else if (verdict.exhausted) {
    body = labels.exhausted;
    variant = 'warning';
    const resetsAtMs = verdict.tightest.resetsAtMs;
    if (resetsAtMs !== undefined && resetsAtMs > nowMs) {
      body = `${labels.exhausted} · ${labels.resetsIn.replace(
        '{duration}',
        formatCompactDuration(resetsAtMs - nowMs)
      )}`;
    }
  } else {
    const remaining = Math.max(0, 100 - verdict.tightest.usedPercent);
    body = labels.remaining.replace('{percent}', String(Math.round(remaining)));
    if (remaining <= 15) variant = 'warning';
  }

  return (
    <button
      type="button"
      onClick={onRefresh}
      disabled={refreshing}
      title={labels.refresh}
      data-testid="header-quota-pill"
      data-verdict={verdict.kind}
      className="shrink-0 cursor-pointer disabled:cursor-default"
    >
      <Badge variant={variant} className="gap-1.5 normal-case tracking-normal font-mono">
        <RefreshCw size={10} className={refreshing ? 'animate-spin' : undefined} />
        {body}
      </Badge>
    </button>
  );
}
