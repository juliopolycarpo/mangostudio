/**
 * Agents screen: one card per agent CLI target, on the machine the scope picker
 * names.
 */

import { useI18n } from '@/hooks/use-i18n';
import { useAgentCliStatuses, useInstallRecipes } from '../hooks/use-runtime-status';
import { useEnvironmentScope } from '../use-environment-scope';
import { AgentCliCard } from './AgentCliCard';
import { EnvironmentPageState } from './EnvironmentPageState';
import { EnvironmentScopeHeader } from './EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from './EnvironmentScopeNotice';

export function AgentsPage() {
  const { t } = useI18n();
  const e = t.environments;
  const scope = useEnvironmentScope();
  const agents = useAgentCliStatuses(scope.environmentId);
  const recipes = useInstallRecipes();

  const header = (
    <EnvironmentScopeHeader
      description={e.agents.description}
      scope={scope}
      onRefresh={() => void agents.refetch()}
    />
  );

  if (scope.environment && !scope.permitsProbing) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentScopeNotice environment={scope.environment} reason="not-permitted" />
      </div>
    );
  }

  if (agents.isPending && !agents.data) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentPageState variant="loading" />
      </div>
    );
  }

  if (agents.error && !agents.data) {
    return (
      <div className="space-y-4">
        {header}
        {scope.environment && !scope.isConnected ? (
          <EnvironmentScopeNotice environment={scope.environment} reason="disconnected" />
        ) : (
          <EnvironmentPageState variant="error" onRetry={() => void agents.refetch()} />
        )}
      </div>
    );
  }

  const statuses = agents.data ?? [];

  return (
    <div className="space-y-4">
      {header}

      {statuses.length === 0 ? (
        <EnvironmentPageState variant="empty" title={e.agents.empty} hint={e.runtimes.emptyHint} />
      ) : (
        <div className="space-y-4">
          {statuses.map((status) => (
            <AgentCliCard
              key={status.targetId}
              status={status}
              recipes={recipes.data ?? []}
              environmentId={scope.environmentId}
            />
          ))}
        </div>
      )}
    </div>
  );
}
