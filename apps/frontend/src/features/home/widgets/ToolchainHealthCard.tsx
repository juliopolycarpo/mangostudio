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
import { MicroLabel } from '@/components/ui/MicroLabel';
import { SectionCard } from '@/components/ui/SectionCard';
import {
  HEALTH_ORDER,
  healthCountClass,
  healthLabel,
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
  const needsAttention = total - counts.ok;

  return (
    <SectionCard
      label={labels.label}
      tone={cardTone(counts.error > 0, needsAttention > 0)}
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
                <MicroLabel as="p">{healthLabel(t, health)}</MicroLabel>
              </li>
            ))}
          </ul>
          {needsAttention === 0 ? <p className="text-xs text-fg-muted">{labels.allClear}</p> : null}
        </>
      ) : null}
    </SectionCard>
  );
}

function cardTone(hasError: boolean, hasAttention: boolean) {
  if (hasError) return 'error' as const;
  return hasAttention ? ('warning' as const) : ('success' as const);
}
