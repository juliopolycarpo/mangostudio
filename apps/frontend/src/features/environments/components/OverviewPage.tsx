/**
 * The landing page of the environments umbrella.
 *
 * Diagnostic summaries read the queries their tabs already own, while the
 * entity section reads the environment API that also drives chat selection.
 *
 * Sections are siblings on purpose: the grid grows an Environments block once
 * environments are entities, and that is an addition here, not a rewrite.
 */

import { useI18n } from '@/hooks/use-i18n';
import {
  useAgentCliStatuses,
  useInstallRecipes,
  useRuntimeStatuses,
} from '../hooks/use-runtime-status';
import { EnvironmentEntitiesOverview } from './EnvironmentEntitiesOverview';
import { EnvironmentPageState } from './EnvironmentPageState';
import { OverviewAgentCard } from './OverviewAgentCard';
import { OverviewHealthRollup } from './OverviewHealthRollup';
import { OverviewLibrarySnapshot } from './OverviewLibrarySnapshot';
import { OverviewSection } from './OverviewSection';
import { OverviewToolchainCard } from './OverviewToolchainCard';

export function OverviewPage() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <p className="text-sm text-on-surface-variant/60">{t.environments.overview.description}</p>

      <EnvironmentEntitiesOverview />
      <AgentsOverview />
      <ToolchainsOverview />

      <div className="grid gap-6 lg:grid-cols-2">
        <OverviewHealthRollup />
        <OverviewLibrarySnapshot />
      </div>
    </div>
  );
}

function AgentsOverview() {
  const { t } = useI18n();
  const e = t.environments;
  const agents = useAgentCliStatuses();
  const recipes = useInstallRecipes();
  const statuses = agents.data ?? [];

  return (
    <OverviewSection
      title={e.tabs.agents}
      to="/environments/agents"
      testId="overview-agents"
      isPending={agents.isPending && !agents.data}
      hasError={Boolean(agents.error) && !agents.data}
      onRetry={() => void agents.refetch()}
    >
      {statuses.length === 0 ? (
        <EnvironmentPageState
          variant="empty"
          size="section"
          title={e.overview.agentsEmpty}
          hint={e.overview.agentsEmptyHint}
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {statuses.map((status) => (
            <OverviewAgentCard key={status.targetId} status={status} recipes={recipes.data ?? []} />
          ))}
        </div>
      )}
    </OverviewSection>
  );
}

function ToolchainsOverview() {
  const { t } = useI18n();
  const e = t.environments;
  const runtimes = useRuntimeStatuses();
  const statuses = runtimes.data ?? [];

  return (
    <OverviewSection
      title={e.tabs.runtimes}
      to="/environments/runtimes"
      testId="overview-toolchains"
      isPending={runtimes.isPending && !runtimes.data}
      hasError={Boolean(runtimes.error) && !runtimes.data}
      onRetry={() => void runtimes.refetch()}
    >
      {statuses.length === 0 ? (
        <EnvironmentPageState variant="empty" size="section" title={e.overview.toolchainsEmpty} />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {statuses.map((status) => (
            <OverviewToolchainCard key={status.id} status={status} />
          ))}
        </div>
      )}
    </OverviewSection>
  );
}
