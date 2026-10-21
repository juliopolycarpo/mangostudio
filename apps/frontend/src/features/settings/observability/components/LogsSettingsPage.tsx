import type { ProviderProbeOperation } from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Chip } from '@/components/ui/Chip';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { observabilityLogsQueryOptions } from '../queries';
import { formatTimestamp } from '../utils';
import { ExternalAgentDiscoveryLog } from './ExternalAgentDiscoveryLog';

export function LogsSettingsPage() {
  const { t, locale } = useI18n();
  const { data, error, isLoading, isFetching, refetch } = useQuery(observabilityLogsQueryOptions());
  const labels = t.settings.logs;
  const operationLabels: Record<ProviderProbeOperation, string> = {
    healthcheck: labels.operations.healthcheck,
    'model-list': labels.operations.modelList,
  };

  return (
    <SettingsPage
      title={labels.title}
      description={labels.description}
      actions={
        isLoading || error ? null : (
          <Button variant="secondary" size="sm" onClick={() => void refetch()} loading={isFetching}>
            {!isFetching && <RefreshCw size={ICON_SM} />}
            {labels.refresh}
          </Button>
        )
      }
    >
      {/* The discovery card below is this page's own query, not the probe log's:
          an unreachable metrics endpoint says nothing about how the agents were
          discovered, and gating it behind that request only delays it. */}
      {isLoading ? (
        <div role="status" className="space-y-3">
          <Skeleton className="h-20 w-full rounded-md" />
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : error ? (
        <Callout tone="danger">{labels.failedToLoad}</Callout>
      ) : data?.entries.length ? (
        <SettingsSection>
          {data.entries.map((entry) => (
            <div key={entry.id} className="space-y-1 px-4 py-3">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <h3 className="text-sm font-semibold text-fg">{t.providers[entry.provider]}</h3>
                <Badge variant="warning">{labels.eventKinds.probeTimeout}</Badge>
                <span className="ml-auto text-xs text-fg-muted">
                  {formatTimestamp(entry.timestamp, locale)}
                </span>
              </div>
              <p className="text-sm text-fg">{entry.message}</p>
              <Chip label={labels.operationLabel}>{operationLabels[entry.operation]}</Chip>
            </div>
          ))}
        </SettingsSection>
      ) : (
        <SettingsSection>
          <p className="px-4 py-3 text-sm text-fg-muted">{labels.empty}</p>
        </SettingsSection>
      )}

      <ExternalAgentDiscoveryLog />
    </SettingsPage>
  );
}
