import type { ProviderProbeOperation } from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';

import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { Chip } from '@/components/ui/Chip';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

import { observabilityLogsQueryOptions } from '../queries';
import { formatTimestamp } from '../utils';
import { ExternalAgentDiscoveryLog } from './ExternalAgentDiscoveryLog';
import { ObservabilityPageActions } from './ObservabilityPageActions';

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
        data ? (
          <ObservabilityPageActions
            updatedLabel={labels.generatedAtLabel.replace(
              '{value}',
              formatTimestamp(data.generatedAt, locale)
            )}
            refreshLabel={labels.refresh}
            refreshing={isFetching}
            onRefresh={() => void refetch()}
          />
        ) : null
      }
    >
      {/* The discovery card below is this page's own query, not the probe log's:
          an unreachable metrics endpoint says nothing about how the agents were
          discovered, and gating it behind that request only delays it. */}
      {isLoading ? (
        <div
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
          role="status"
          className="space-y-3"
        >
          <Skeleton className="h-20 w-full rounded-md" />
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : error ? (
        <Callout
          tone="danger"
          action={
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void refetch()}
              loading={isFetching}
            >
              {t.common.retry}
            </Button>
          }
        >
          {labels.failedToLoad}
        </Callout>
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
        // A quiet log is nothing to fix, so the empty state has no action: its
        // hint says what would show up here and when.
        <Card padded={false}>
          <EmptyState
            icon={<ScrollText size={ICON_LG} />}
            title={labels.empty}
            hint={labels.emptyHint}
          />
        </Card>
      )}

      <ExternalAgentDiscoveryLog />
    </SettingsPage>
  );
}
