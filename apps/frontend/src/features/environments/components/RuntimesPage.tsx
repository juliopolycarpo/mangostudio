/**
 * Runtimes screen: one card per runtime, plus every version manager's
 * managed Node versions (nvm, fnm, …) folded into the Node card where they
 * belong.
 *
 * Everything here is about one machine, named by the scope picker. Switching
 * machines switches the dataset outright rather than merging — "which node
 * runs" has a different answer on each of them, and a blend of the two is not
 * an answer about anything.
 */

import { useI18n } from '@/hooks/use-i18n';
import { renderableVersionManagers } from '../format';
import { useRuntimesScreenData } from '../hooks/use-runtime-status';
import { useEnvironmentScope } from '../use-environment-scope';
import { EnvironmentPageState } from './EnvironmentPageState';
import { EnvironmentScopeHeader } from './EnvironmentScopeHeader';
import { EnvironmentScopeNotice } from './EnvironmentScopeNotice';
import { NodeVersionTable } from './NodeVersionTable';
import { PrerequisiteCard } from './PrerequisiteCard';
import { RuntimeCard } from './RuntimeCard';

export function RuntimesPage() {
  const { t } = useI18n();
  const e = t.environments;
  const scope = useEnvironmentScope();
  const { runtimes, versionManagers, recipes, isPending, error, refetch } = useRuntimesScreenData(
    scope.environmentId
  );

  const managerTables = renderableVersionManagers(versionManagers, recipes);

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
          {runtimes.map((runtime) =>
            // winget is never installed or updated by MangoStudio — it only
            // ever appears as something the other Windows recipes need, so it
            // renders as the compact prerequisite card rather than a runtime
            // with its own lifecycle.
            runtime.id === 'winget' ? (
              <PrerequisiteCard
                key={runtime.id}
                status={runtime}
                environmentId={scope.environmentId}
              />
            ) : (
              <RuntimeCard
                key={runtime.id}
                status={runtime}
                recipes={recipes}
                environmentId={scope.environmentId}
              >
                {/* Every version manager gets its own table here, not only nvm —
                    but only the ones this machine can actually act on, so an
                    absent manager with no install path here (fnm on POSIX)
                    does not add a dead row inside the Node card. */}
                {runtime.id === 'node' &&
                  managerTables.map((manager) => (
                    <NodeVersionTable
                      key={manager.id}
                      status={manager}
                      recipes={recipes}
                      environmentId={scope.environmentId}
                    />
                  ))}
              </RuntimeCard>
            )
          )}
        </div>
      )}
    </div>
  );
}
