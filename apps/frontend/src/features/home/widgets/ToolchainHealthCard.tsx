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

import { Link } from '@tanstack/react-router';

import { SectionCard } from '@/components/ui/SectionCard';
import {
  HEALTH_ORDER,
  healthCountClass,
  healthLabel,
  type HealthRollup,
  healthRollup,
} from '@/features/environments/format';
import {
  useAgentCliStatuses,
  useRuntimeStatuses,
} from '@/features/environments/hooks/use-runtime-status';
import { useI18n } from '@/hooks/use-i18n';

import { CARD_LINK_CLASS } from './card-link';
import { HubSkeletonLines } from './HubSkeletonLines';

export function ToolchainHealthCard() {
  const { t } = useI18n();
  const labels = t.home.toolchain;
  const runtimes = useRuntimeStatuses();
  const agents = useAgentCliStatuses();

  const hasData = runtimes.data !== undefined && agents.data !== undefined;
  if (runtimes.isError || agents.isError) return null;

  const counts = healthRollup([runtimes.data ?? [], agents.data ?? []]);
  const total = HEALTH_ORDER.reduce((sum, health) => sum + counts[health], 0);

  return (
    <SectionCard
      label={labels.label}
      tone={cardTone(counts, total)}
      action={
        <Link to="/environments/health" className={CARD_LINK_CLASS}>
          {labels.open}
        </Link>
      }
    >
      {!hasData ? <HubSkeletonLines /> : null}

      {hasData && total === 0 ? <p className="text-xs text-fg-muted">{labels.empty}</p> : null}

      {hasData && total > 0 ? (
        <>
          <ul className="grid grid-cols-2 gap-3" data-testid="home-health-rollup">
            {HEALTH_ORDER.map((health) => (
              <li key={health} className="space-y-0.5" data-health={health}>
                <p
                  className={`text-title font-semibold ${healthCountClass(health, counts[health])}`}
                >
                  {counts[health]}
                </p>
                <p className="text-xs text-fg-muted">{healthLabel(t, health)}</p>
              </li>
            ))}
          </ul>
          {counts.ok === total ? <p className="text-xs text-fg-muted">{labels.allClear}</p> : null}
        </>
      ) : null}
    </SectionCard>
  );
}

/**
 * The header dot, read off the same buckets the tiles below it show.
 *
 * A fault is `error`; a thing the person can fix (`warn`, the tile that says
 * "needs attention") is `warning`. A tool that is simply not installed is
 * `neutral`, never amber: an optional CLI that was never there is not unwell,
 * and a healthy landing page shows no amber (patterns.md, Status). Counting
 * everything that is not `ok` painted the dot yellow over a "needs attention"
 * tile that read 0.
 */
function cardTone(counts: HealthRollup, total: number) {
  if (counts.error > 0) return 'error' as const;
  if (counts.warn > 0) return 'warning' as const;
  return total === 0 || counts.missing > 0 ? ('neutral' as const) : ('success' as const);
}
