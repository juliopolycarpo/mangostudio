import type {
  ProviderCacheMetrics,
  ProviderCacheName,
  ProviderProbeOperation,
  ProviderUsageMetrics,
} from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { BarChart3 } from 'lucide-react';

import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatCompactDuration } from '@/features/settings/connectors/components/ChatGptUsageMeter';
import { connectorQueryOptions } from '@/features/settings/connectors/hooks/use-connectors';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_LG } from '@/lib/icon-sizes';

import { observabilityMetricsQueryOptions } from '../queries';
import { formatPercent, formatTimestamp, formatTokenCount } from '../utils';
import { ChatGptMetricsCard } from './ChatGptMetricsCard';
import { ObservabilityPageActions } from './ObservabilityPageActions';

/** ChatGPT usage snapshots are cached ~5 min server-side, so poll leisurely. */
const CHATGPT_REFETCH_MS = 60_000;

/**
 * A block of a provider's card, at a settings row's inset. The card divides the
 * blocks with its own `stroke` hairline, as it divides `SettingsRow`s.
 */
const BLOCK = 'space-y-3 px-4 py-3';

/** Every cell sits at the card's 16px inset, so the table's rows run edge to edge like `SettingsRow`s. */
const CELL = 'whitespace-nowrap px-4';
const NUMERIC_CELL = `${CELL} w-24 text-right`;

/**
 * Hits, misses and hit rate are right-aligned at a fixed width so the digits
 * line up down the column, and the last one ends on the card's inset, where the
 * probe-timeout counts below it end too. The cache name takes the rest.
 */
function CacheMetricsTable(props: {
  /** Names the table for a screen reader; the column headers name it for everyone else. */
  caption: string;
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
        <caption className="sr-only">{props.caption}</caption>
        <thead>
          <tr className="text-left text-xs text-fg-muted">
            <th scope="col" className={`${CELL} pt-3 pb-2 font-medium`}>
              {props.cacheLabel}
            </th>
            <th scope="col" className={`${NUMERIC_CELL} pt-3 pb-2 font-medium`}>
              {props.hitsLabel}
            </th>
            <th scope="col" className={`${NUMERIC_CELL} pt-3 pb-2 font-medium`}>
              {props.missesLabel}
            </th>
            <th scope="col" className={`${NUMERIC_CELL} pt-3 pb-2 font-medium`}>
              {props.hitRateLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={entry.cacheName} className="border-t border-stroke">
              <td className={`${CELL} py-3 text-fg`}>{props.cacheLabels[entry.cacheName]}</td>
              <td className={`${NUMERIC_CELL} py-3 text-fg tabular-nums`}>{entry.hits}</td>
              <td className={`${NUMERIC_CELL} py-3 text-fg tabular-nums`}>{entry.misses}</td>
              <td className={`${NUMERIC_CELL} py-3 text-fg tabular-nums`}>
                {/* A cache nothing has asked yet has no rate. "0%" reads as a cache
                    that always misses, which is a different thing to be told. */}
                {entry.hits + entry.misses === 0 ? (
                  <span className="text-fg-subtle">—</span>
                ) : (
                  formatPercent(entry.hitRate)
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageStat(props: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-fg-muted">{props.label}</dt>
      <dd className="mt-0.5 text-base font-medium text-fg tabular-nums">{props.value}</dd>
      {props.hint ? <dd className="mt-0.5 text-xs text-fg-subtle">{props.hint}</dd> : null}
    </div>
  );
}

function UsageSummary(props: {
  labels: {
    textTurnsLabel: string;
    imageGenerationsLabel: string;
    inputTokensLabel: string;
    inputTokensHint: string;
    lastUsedLabel: string;
    lastUsedAgoLabel: string;
  };
  usage: ProviderUsageMetrics;
  now: number;
  locale: 'pt-BR' | 'en';
}) {
  const lastUsedAgo =
    props.usage.lastUsedAt !== undefined
      ? props.labels.lastUsedAgoLabel.replace(
          '{time}',
          formatCompactDuration(props.now - props.usage.lastUsedAt)
        )
      : null;

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
      <UsageStat label={props.labels.textTurnsLabel} value={props.usage.textTurns} />
      <UsageStat label={props.labels.imageGenerationsLabel} value={props.usage.imageGenerations} />
      <UsageStat
        label={props.labels.inputTokensLabel}
        value={formatTokenCount(props.usage.inputTokens, props.locale)}
        hint={props.labels.inputTokensHint}
      />
      <UsageStat label={props.labels.lastUsedLabel} value={lastUsedAgo ?? '—'} />
    </dl>
  );
}

export function MetricsSettingsPage() {
  const { t, locale } = useI18n();
  const { data, error, isLoading, isFetching, refetch } = useQuery(
    observabilityMetricsQueryOptions()
  );
  const connectorsQuery = useQuery({
    ...connectorQueryOptions(),
    refetchInterval: CHATGPT_REFETCH_MS,
  });
  const chatGptConnectors = (connectorsQuery.data?.connectors ?? []).filter(
    (connector) => connector.provider === 'chatgpt' && !connector.needsReauth
  );
  const now = Date.now();
  const labels = t.settings.metrics;
  const cacheLabels: Record<ProviderCacheName, string> = {
    'sdk-client': labels.caches.sdkClient,
    'prepared-runtime': labels.caches.preparedRuntime,
    'provider-route': labels.caches.providerRoute,
  };
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
      {chatGptConnectors.map((connector) => (
        <ChatGptMetricsCard
          key={connector.id}
          connector={connector}
          onRedeemed={() => void connectorsQuery.refetch()}
        />
      ))}

      {isLoading ? (
        <div
          // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- The status live region announces changes without implying a calculation output.
          role="status"
          className="space-y-3"
        >
          <Skeleton className="h-40 w-full rounded-md" />
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
      ) : data?.providers.length ? (
        data.providers.map((providerMetrics) => (
          <SettingsSection
            key={providerMetrics.provider}
            title={t.providers[providerMetrics.provider]}
            action={
              // A count with no weight is easy to miss when it is not zero, so it
              // carries a tone: neutral while healthy, warning once a probe timed out.
              <Badge variant={providerMetrics.totalProbeTimeouts > 0 ? 'warning' : 'neutral'}>
                {labels.totalProbeTimeoutsLabel.replace(
                  '{value}',
                  String(providerMetrics.totalProbeTimeouts)
                )}
              </Badge>
            }
          >
            {providerMetrics.usage ? (
              <section className={BLOCK}>
                <MicroLabel as="h4" className="block">
                  {labels.usageSectionTitle}
                </MicroLabel>
                <UsageSummary
                  labels={{
                    textTurnsLabel: labels.usageTextTurnsLabel,
                    imageGenerationsLabel: labels.usageImageGenerationsLabel,
                    inputTokensLabel: labels.usageInputTokensLabel,
                    inputTokensHint: labels.usageInputTokensHint,
                    lastUsedLabel: labels.usageLastUsedLabel,
                    lastUsedAgoLabel: labels.usageLastUsedAgoLabel,
                  }}
                  usage={providerMetrics.usage}
                  now={now}
                  locale={locale}
                />
              </section>
            ) : null}

            <section>
              <CacheMetricsTable
                caption={labels.cacheSectionTitle}
                cacheLabel={labels.cacheLabel}
                cacheLabels={cacheLabels}
                hitRateLabel={labels.hitRateLabel}
                hitsLabel={labels.hitsLabel}
                missesLabel={labels.missesLabel}
                entries={providerMetrics.caches}
              />
            </section>

            {/* The heading already says "Probe timeouts: 0"; a breakdown of zeros under it
                is the same fact once per operation, so a healthy provider shows none. */}
            {providerMetrics.totalProbeTimeouts > 0 ? (
              <section className={BLOCK}>
                <MicroLabel as="h4" className="block">
                  {labels.probeSectionTitle}
                </MicroLabel>
                <ul className="divide-y divide-stroke">
                  {providerMetrics.probeTimeouts.map((entry) => (
                    <li
                      key={entry.operation}
                      className="flex items-center justify-between gap-3 py-2 text-sm first:pt-0 last:pb-0"
                    >
                      <span className="text-fg">{operationLabels[entry.operation]}</span>
                      <span className="font-medium text-fg tabular-nums">{entry.timeoutCount}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </SettingsSection>
        ))
      ) : (
        <Card padded={false}>
          <EmptyState icon={<BarChart3 size={ICON_LG} />} title={labels.empty} />
        </Card>
      )}
    </SettingsPage>
  );
}
