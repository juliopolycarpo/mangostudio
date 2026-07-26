/**
 * Agents screen: one card per agent CLI target.
 */

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useAgentCliStatuses, useInstallRecipes } from '../hooks/use-runtime-status';
import { AgentCliCard } from './AgentCliCard';
import { EnvironmentPageState } from './EnvironmentPageState';

export function AgentsPage() {
  const { t } = useI18n();
  const e = t.environments;
  const agents = useAgentCliStatuses();
  const recipes = useInstallRecipes();

  if (agents.isPending && !agents.data) {
    return <EnvironmentPageState variant="loading" />;
  }

  if (agents.error && !agents.data) {
    return <EnvironmentPageState variant="error" onRetry={() => void agents.refetch()} />;
  }

  const statuses = agents.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-on-surface-variant/60">{e.agents.description}</p>
        <Button variant="ghost" size="sm" onClick={() => void agents.refetch()}>
          {e.actions.refresh}
        </Button>
      </div>

      {statuses.length === 0 ? (
        <EnvironmentPageState variant="empty" title={e.agents.empty} hint={e.runtimes.emptyHint} />
      ) : (
        <div className="space-y-4">
          {statuses.map((status) => (
            <AgentCliCard key={status.targetId} status={status} recipes={recipes.data ?? []} />
          ))}
        </div>
      )}
    </div>
  );
}
