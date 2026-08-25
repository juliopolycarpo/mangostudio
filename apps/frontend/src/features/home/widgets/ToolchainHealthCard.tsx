/**
 * How much of the toolchain is ready, as four counts.
 *
 * The dashboard's read of what `/environments/health` says in full. It reuses
 * that page's own `healthRollup` and `healthLabel` rather than re-deriving the
 * numbers, so the two can never disagree about how many things need attention
 * — only the presentation is new, because a page section with its own heading
 * and "Open Health" affordance is not a card.
 *
 * Silent while either list is missing: a rollup drawn from one of the two
 * sources is not a smaller truth, it is the wrong number, and half a rollup
 * reading "nothing needs attention" is exactly the lie worth staying quiet to
 * avoid.
 */

import type { RuntimeHealth } from '@mangostudio/shared/environments';
import { Link } from '@tanstack/react-router';
import { SectionCard } from '@/components/ui/SectionCard';
import { healthLabel, healthRollup } from '@/features/environments/format';
import {
  useAgentCliStatuses,
  useRuntimeStatuses,
} from '@/features/environments/hooks/use-runtime-status';
import { useI18n } from '@/hooks/use-i18n';
import { HubSkeletonLines } from './HubSkeletonLines';

/** Worst first: the reason to open this card is at the top of the list. */
const HEALTH_ORDER: readonly RuntimeHealth[] = ['error', 'missing', 'warn', 'ok'];

const COUNT_STYLES: Record<RuntimeHealth, string> = {
  ok: 'text-primary',
  warn: 'text-warning',
  missing: 'text-on-surface-variant',
  error: 'text-error',
};

export function ToolchainHealthCard() {
  const { t } = useI18n();
  const labels = t.home.toolchain;
  const runtimes = useRuntimeStatuses();
  const agents = useAgentCliStatuses();

  const hasData = runtimes.data !== undefined && agents.data !== undefined;
  if (runtimes.isError || agents.isError) return null;

  const counts = healthRollup([runtimes.data ?? [], agents.data ?? []]);
  const total = HEALTH_ORDER.reduce((sum, health) => sum + counts[health], 0);
  const needsAttention = total - counts.ok;

  return (
    <SectionCard
      label={labels.label}
      tone={cardTone(counts.error > 0, needsAttention > 0)}
      action={
        <Link
          to="/environments/health"
          className="micro-label text-primary/80 transition-colors hover:text-primary"
        >
          {labels.open}
        </Link>
      }
    >
      {!hasData ? <HubSkeletonLines /> : null}

      {hasData && total === 0 ? (
        <p className="text-xs text-on-surface-variant">{labels.empty}</p>
      ) : null}

      {hasData && total > 0 ? (
        <>
          <ul className="grid grid-cols-4 gap-2" data-testid="home-health-rollup">
            {HEALTH_ORDER.map((health) => (
              <li key={health} className="min-w-0 space-y-0.5" data-health={health}>
                <p className={`font-headline text-xl font-bold ${COUNT_STYLES[health]}`}>
                  {counts[health]}
                </p>
                <p className="micro-label truncate text-on-surface-variant/60">
                  {healthLabel(t, health)}
                </p>
              </li>
            ))}
          </ul>
          {needsAttention === 0 ? (
            <p className="text-xs text-on-surface-variant/70">{labels.allClear}</p>
          ) : null}
        </>
      ) : null}
    </SectionCard>
  );
}

function cardTone(hasError: boolean, hasAttention: boolean) {
  if (hasError) return 'error' as const;
  return hasAttention ? ('warning' as const) : ('success' as const);
}
