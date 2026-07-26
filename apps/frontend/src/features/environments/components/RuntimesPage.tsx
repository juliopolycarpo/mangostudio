/**
 * Runtimes screen: one card per runtime, plus the nvm-managed Node versions
 * folded into the Node card where they belong.
 */

import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { useRuntimesScreenData } from '../hooks/use-runtime-status';
import { EnvironmentPageState } from './EnvironmentPageState';
import { NodeVersionTable } from './NodeVersionTable';
import { RuntimeCard } from './RuntimeCard';

export function RuntimesPage() {
  const { t } = useI18n();
  const e = t.environments;
  const { runtimes, versionManagers, recipes, isPending, error, refetch } = useRuntimesScreenData();

  if (isPending && runtimes.length === 0) {
    return <EnvironmentPageState variant="loading" />;
  }

  if (error && runtimes.length === 0) {
    return <EnvironmentPageState variant="error" onRetry={refetch} />;
  }

  const nvm = versionManagers.find((manager) => manager.id === 'nvm');

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-on-surface-variant/60">{e.runtimes.description}</p>
        <Button variant="ghost" size="sm" onClick={refetch}>
          {e.actions.refresh}
        </Button>
      </div>

      {runtimes.length === 0 ? (
        <EnvironmentPageState
          variant="empty"
          title={e.runtimes.empty}
          hint={e.runtimes.emptyHint}
        />
      ) : (
        <div className="space-y-4">
          {runtimes.map((runtime) => (
            <RuntimeCard key={runtime.id} status={runtime} recipes={recipes}>
              {runtime.id === 'node' && nvm ? (
                <NodeVersionTable status={nvm} recipes={recipes} />
              ) : null}
            </RuntimeCard>
          ))}
        </div>
      )}
    </div>
  );
}
