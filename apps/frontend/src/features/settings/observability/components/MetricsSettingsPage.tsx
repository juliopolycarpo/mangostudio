import type {
  ProviderCacheMetrics,
  ProviderCacheName,
  ProviderProbeOperation,
} from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useI18n } from '@/hooks/use-i18n';
import { observabilityMetricsQueryOptions } from '../queries';
import { formatPercent, formatTimestamp } from '../utils';

function CacheMetricsTable(props: {
  cacheLabel: string;
  cacheLabels: Record<ProviderCacheName, string>;
  hitRateLabel: string;
  hitsLabel: string;
  missesLabel: string;
  entries: ReadonlyArray<ProviderCacheMetrics>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-on-surface-variant/70">
            <th className="whitespace-nowrap py-2 pr-4 font-medium">{props.cacheLabel}</th>
            <th className="whitespace-nowrap py-2 pr-4 font-medium">{props.hitsLabel}</th>
            <th className="whitespace-nowrap py-2 pr-4 font-medium">{props.missesLabel}</th>
            <th className="whitespace-nowrap py-2 font-medium">{props.hitRateLabel}</th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={entry.cacheName} className="border-t border-outline-variant/10">
              <td className="whitespace-nowrap py-2 pr-4 text-on-surface">
                {props.cacheLabels[entry.cacheName]}
              </td>
              <td className="whitespace-nowrap py-2 pr-4 text-on-surface">{entry.hits}</td>
              <td className="whitespace-nowrap py-2 pr-4 text-on-surface">{entry.misses}</td>
              <td className="whitespace-nowrap py-2 text-on-surface">
                {formatPercent(entry.hitRate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function MetricsSettingsPage() {
  const { t } = useI18n();
  const { data, error, isLoading, isFetching, refetch } = useQuery(
    observabilityMetricsQueryOptions()
  );
  const labels = t.settings.metrics;
  const generatedAtLabel = data?.generatedAt ? formatTimestamp(data.generatedAt) : '-';
  const cacheLabels: Record<ProviderCacheName, string> = {
    'sdk-client': labels.caches.sdkClient,
    'prepared-runtime': labels.caches.preparedRuntime,
    'provider-route': labels.caches.providerRoute,
  };
  const operationLabels: Record<ProviderProbeOperation, string> = {
    healthcheck: labels.operations.healthcheck,
    'model-list': labels.operations.modelList,
  };

  if (isLoading) {
    return (
      <Card variant="solid" className="p-4 sm:p-6 text-sm text-on-surface-variant/70">
        {t.common.loading}
      </Card>
    );
  }

  if (error) {
    return (
      <Card variant="solid" className="p-4 sm:p-6 text-sm text-error">
        {labels.failedToLoad}
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card variant="solid" className="space-y-4 p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-on-surface">{labels.title}</h2>
            <p className="text-sm text-on-surface-variant/70">{labels.description}</p>
            <p className="text-xs text-on-surface-variant/60">
              {labels.generatedAtLabel.replace('{value}', generatedAtLabel)}
            </p>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void refetch()} loading={isFetching}>
            {labels.refresh}
          </Button>
        </div>
      </Card>

      {data?.providers.length ? (
        data.providers.map((providerMetrics) => (
          <Card key={providerMetrics.provider} variant="solid" className="space-y-4 p-4 sm:p-6">
            <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
              <h3 className="text-base font-semibold text-on-surface">
                {t.providers[providerMetrics.provider]}
              </h3>
              <span className="text-sm text-on-surface-variant/70">
                {labels.totalProbeTimeoutsLabel.replace(
                  '{value}',
                  String(providerMetrics.totalProbeTimeouts)
                )}
              </span>
            </div>

            <div className="grid gap-4">
              <div className="space-y-3">
                <h4 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                  {labels.cacheSectionTitle}
                </h4>
                <CacheMetricsTable
                  cacheLabel={labels.cacheLabel}
                  cacheLabels={cacheLabels}
                  hitRateLabel={labels.hitRateLabel}
                  hitsLabel={labels.hitsLabel}
                  missesLabel={labels.missesLabel}
                  entries={providerMetrics.caches}
                />
              </div>

              <div className="space-y-3">
                <h4 className="text-xs uppercase tracking-widest font-bold text-on-surface-variant/80 font-label">
                  {labels.probeSectionTitle}
                </h4>
                <div className="space-y-2">
                  {providerMetrics.probeTimeouts.map((entry) => (
                    <div
                      key={entry.operation}
                      className="grid grid-cols-[1fr_auto] items-center gap-3 rounded-xl bg-surface-container-lowest px-4 py-3"
                    >
                      <span className="text-sm text-on-surface">
                        {operationLabels[entry.operation]}
                      </span>
                      <span className="rounded-full bg-surface-container-high px-2.5 py-1 text-xs font-semibold text-on-surface tabular-nums">
                        {entry.timeoutCount}
                      </span>
                    </div>
                  ))}
                </div>
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
