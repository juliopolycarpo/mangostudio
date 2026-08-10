import type { ProviderProbeOperation } from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { observabilityLogsQueryOptions } from '../queries';
import { formatTimestamp } from '../utils';
import { ExternalAgentDiscoveryLog } from './ExternalAgentDiscoveryLog';

export function LogsSettingsPage() {
  const { t } = useI18n();
  const { data, error, isLoading, isFetching, refetch } = useQuery(observabilityLogsQueryOptions());
  const labels = t.settings.logs;
  const operationLabels: Record<ProviderProbeOperation, string> = {
    healthcheck: labels.operations.healthcheck,
    'model-list': labels.operations.modelList,
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        {/* Same independence as the error branch below: the discovery query is
            this component's, not the probe log's, and gating it behind that
            request only delays it. */}
        <ExternalAgentDiscoveryLog />
        <Card variant="solid" className="p-4 sm:p-6 text-sm text-on-surface-variant/70">
          {t.common.loading}
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-4">
        <Card variant="solid" className="p-4 sm:p-6 text-sm text-error">
          {labels.failedToLoad}
        </Card>
        {/* Independent of the provider probe log: an unreachable metrics
            endpoint says nothing about how the agents were discovered. */}
        <ExternalAgentDiscoveryLog />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ExternalAgentDiscoveryLog />
      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-on-surface">{labels.title}</h2>
            <p className="text-sm text-on-surface-variant/70">{labels.description}</p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refetch()} loading={isFetching}>
            {labels.refresh}
          </Button>
        </div>
      </Card>

      {data?.entries.length ? (
        data.entries.map((entry) => (
          <Card key={entry.id} variant="solid" className="space-y-3 p-4 sm:p-6">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                  {labels.eventKinds.probeTimeout}
                </p>
                <h3 className="text-base font-semibold text-on-surface">
                  {t.providers[entry.provider]}
                </h3>
                <p className="text-sm text-on-surface">{entry.message}</p>
              </div>
              <span className="text-xs text-on-surface-variant/60">
                {formatTimestamp(entry.timestamp)}
              </span>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl bg-surface-container-lowest px-4 py-3">
                <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/70 font-label">
                  {labels.providerLabel}
                </p>
                <p className="mt-1 text-sm text-on-surface">{t.providers[entry.provider]}</p>
              </div>
              <div className="rounded-xl bg-surface-container-lowest px-4 py-3">
                <p className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/70 font-label">
                  {labels.operationLabel}
                </p>
                <p className="mt-1 text-sm text-on-surface">{operationLabels[entry.operation]}</p>
              </div>
            </div>
          </Card>
        ))
      ) : (
        <Card variant="solid" className="p-4 sm:p-6 text-sm text-on-surface-variant/70">
          {labels.empty}
        </Card>
      )}
    </div>
  );
}
