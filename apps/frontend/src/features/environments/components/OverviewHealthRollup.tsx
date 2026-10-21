/**
 * Health as counts: how many tools sit in each state, and nothing else.
 *
 * The numbers come from the reported health of every runtime and agent, so a
 * tool that is installed somewhere the shell cannot reach it is counted as
 * needing attention here exactly as its own card says. A rollup that quietly
 * rounded that up to "available" would be the most-read lie on the page.
 */

import { Card } from '@/components/ui/Card';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { HEALTH_ORDER, healthCountClass, healthLabel, healthRollup } from '../format';
import { useAgentCliStatuses, useRuntimeStatuses } from '../hooks/use-runtime-status';
import { EnvironmentPageState } from './EnvironmentPageState';
import { OverviewSection } from './OverviewSection';

export function OverviewHealthRollup() {
  const { t } = useI18n();
  const e = t.environments;
  const runtimes = useRuntimeStatuses();
  const agents = useAgentCliStatuses();

  const counts = healthRollup([runtimes.data ?? [], agents.data ?? []]);
  const total = HEALTH_ORDER.reduce((sum, health) => sum + counts[health], 0);
  // Both sources or none: a count drawn from one of them is not a smaller
  // truth, it is the wrong number. Half a rollup reading "nothing needs
  // attention" is exactly the lie this section exists not to tell.
  const hasData = runtimes.data !== undefined && agents.data !== undefined;

  return (
    <OverviewSection
      title={e.tabs.health}
      to="/environments/health"
      testId="overview-health"
      isPending={(runtimes.isPending || agents.isPending) && !hasData}
      hasError={Boolean(runtimes.error ?? agents.error) && !hasData}
      onRetry={() => {
        void runtimes.refetch();
        void agents.refetch();
      }}
    >
      {total === 0 ? (
        <EnvironmentPageState variant="empty" size="section" title={e.health.empty} />
      ) : (
        <Card>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="health-rollup">
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
          {counts.ok === total && (
            <p className="mt-3 text-sm text-fg-muted">{e.overview.healthClear}</p>
          )}
        </Card>
      )}
    </OverviewSection>
  );
}
