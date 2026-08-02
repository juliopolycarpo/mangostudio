/**
 * Runtimes screen: one card per runtime, plus the nvm-managed Node versions
 * folded into the Node card where they belong.
 *
 * Everything here is about one machine, named by the scope picker. Switching
 * machines switches the dataset outright rather than merging — "which node
 * runs" has a different answer on each of them, and a blend of the two is not
 * an answer about anything.
 */

import { useI18n } from '@/hooks/use-i18n';
import { useRuntimesScreenData } from '../hooks/use-runtime-status';
import { useEnvironmentScope } from '../use-environment-scope';
import { EnvironmentPageState } from './EnvironmentPageState';
import { EnvironmentScopeHeader } from './EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from './EnvironmentScopeNotice';
import { NodeVersionTable } from './NodeVersionTable';
import { RuntimeCard } from './RuntimeCard';

export function RuntimesPage() {
  const { t } = useI18n();
  const e = t.environments;
  const scope = useEnvironmentScope();
  const { runtimes, versionManagers, recipes, isPending, error, refetch } = useRuntimesScreenData(
    scope.environmentId
  );

  const header = (
    <EnvironmentScopeHeader
      description={e.runtimes.description}
      scope={scope}
      onRefresh={refetch}
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

  if (isPending && runtimes.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        <EnvironmentPageState variant="loading" />
      </div>
    );
  }

  if (error && runtimes.length === 0) {
    return (
      <div className="space-y-4">
        {header}
        {scope.environment && !scope.isConnected ? (
          <EnvironmentScopeNotice environment={scope.environment} reason="disconnected" />
        ) : (
          <EnvironmentPageState variant="error" onRetry={refetch} />
        )}
      </div>
    );
  }

  const nvm = versionManagers.find((manager) => manager.id === 'nvm');

  return (
    <div className="space-y-4">
      {header}

      {runtimes.length === 0 ? (
        <EnvironmentPageState
          variant="empty"
          title={e.runtimes.empty}
          hint={e.runtimes.emptyHint}
        />
      ) : (
        <div className="space-y-4">
          {runtimes.map((runtime) => (
            <RuntimeCard
              key={runtime.id}
              status={runtime}
              recipes={recipes}
              environmentId={scope.environmentId}
            >
              {runtime.id === 'node' && nvm ? (
                <NodeVersionTable
                  status={nvm}
                  recipes={recipes}
                  environmentId={scope.environmentId}
                />
              ) : null}
            </RuntimeCard>
          ))}
        </div>
      )}
    </div>
  );
}
