/**
 * Health as counts: how many tools sit in each state, and nothing else.
 *
 * The numbers come from the reported health of every runtime and agent, so a
 * tool that is installed somewhere the shell cannot reach it is counted as
 * needing attention here exactly as its own card says. A rollup that quietly
 * rounded that up to "available" would be the most-read lie on the page.
 */

import type { RuntimeHealth } from '@mangostudio/shared/environments';
import { useI18n } from '@/hooks/use-i18n';
import { healthLabel, healthRollup } from '../format';
import { useAgentCliStatuses, useRuntimeStatuses } from '../hooks/use-runtime-status';
import { EnvironmentPageState } from './EnvironmentPageState';
import { OverviewSection } from './OverviewSection';
import { CardSectionLabel, TOOL_CARD_SURFACE } from './ToolCard';

/** Worst first: the reason to open this section is at the top of the list. */
const HEALTH_ORDER: readonly RuntimeHealth[] = ['error', 'missing', 'warn', 'ok'];

const COUNT_STYLES: Record<RuntimeHealth, string> = {
  ok: 'text-primary',
  warn: 'text-warning',
  missing: 'text-on-surface-variant',
  error: 'text-error',
};

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
        <div className={`${TOOL_CARD_SURFACE} p-4`}>
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="health-rollup">
            {HEALTH_ORDER.map((health) => (
              <li key={health} className="space-y-0.5" data-health={health}>
                <p className={`font-headline text-2xl font-bold ${COUNT_STYLES[health]}`}>
                  {counts[health]}
                </p>
                <CardSectionLabel>{healthLabel(t, health)}</CardSectionLabel>
              </li>
            ))}
          </ul>
          {counts.ok === total && (
            <p className="mt-3 text-sm text-on-surface-variant/70">{e.overview.healthClear}</p>
          )}
        </div>
      )}
    </OverviewSection>
  );
}
