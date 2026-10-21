import type {
  ProviderCacheMetrics,
  ProviderCacheName,
  ProviderProbeOperation,
  ProviderUsageMetrics,
} from '@mangostudio/shared/observability';
import { useQuery } from '@tanstack/react-query';
import { SettingsPage } from '@/components/settings/SettingsPage';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { Callout } from '@/components/ui/Callout';
import { EmptyState } from '@/components/ui/EmptyState';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Skeleton } from '@/components/ui/Skeleton';
import { formatCompactDuration } from '@/features/settings/connectors/components/ChatGptUsageMeter';
import { connectorQueryOptions } from '@/features/settings/connectors/hooks/use-connectors';
import { useI18n } from '@/hooks/use-i18n';
import { observabilityMetricsQueryOptions } from '../queries';
import { formatPercent, formatTimestamp, formatTokenCount } from '../utils';
import { ChatGptMetricsCard } from './ChatGptMetricsCard';

/** ChatGPT usage snapshots are cached ~5 min server-side, so poll leisurely. */
const CHATGPT_REFETCH_MS = 60_000;

/** A block of a provider's card. The blocks are divided by a hairline, not boxed. */
const BLOCK = 'space-y-3 border-t border-stroke pt-4 first:border-t-0 first:pt-0';

/**
 * Hits, misses and hit rate are right-aligned at a fixed width so the digits
 * line up down the column, and the last one ends on the card's edge, where the
 * probe-timeout counts below it end too. The cache name takes the rest.
 */
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
          <tr className="text-left text-xs text-fg-muted">
            <th scope="col" className="whitespace-nowrap py-2 font-medium">
              {props.cacheLabel}
            </th>
            <th scope="col" className="w-16 whitespace-nowrap py-2 pl-4 text-right font-medium">
              {props.hitsLabel}
            </th>
            <th scope="col" className="w-16 whitespace-nowrap py-2 pl-4 text-right font-medium">
              {props.missesLabel}
            </th>
            <th scope="col" className="w-20 whitespace-nowrap py-2 pl-4 text-right font-medium">
              {props.hitRateLabel}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.entries.map((entry) => (
            <tr key={entry.cacheName} className="border-t border-stroke">
              <td className="whitespace-nowrap py-2 text-fg">
                {props.cacheLabels[entry.cacheName]}
              </td>
              <td className="whitespace-nowrap py-2 pl-4 text-right text-fg tabular-nums">
                {entry.hits}
              </td>
              <td className="whitespace-nowrap py-2 pl-4 text-right text-fg tabular-nums">
                {entry.misses}
              </td>
              <td className="whitespace-nowrap py-2 pl-4 text-right text-fg tabular-nums">
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
  const { data, error, isLoading } = useQuery(observabilityMetricsQueryOptions());
  const connectorsQuery = useQuery({
    ...connectorQueryOptions(),
    refetchInterval: CHATGPT_REFETCH_MS,
  });
  const chatGptConnectors = (connectorsQuery.data?.connectors ?? []).filter(
    (connector) => connector.provider === 'chatgpt' && !connector.needsReauth
  );
  const now = Date.now();
  const labels = t.settings.metrics;
  const generatedAtLabel = data?.generatedAt ? formatTimestamp(data.generatedAt, locale) : '-';
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
        <span className="text-xs text-fg-muted">
          {labels.generatedAtLabel.replace('{value}', generatedAtLabel)}
        </span>
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
        <div role="status" className="space-y-3">
          <Skeleton className="h-40 w-full rounded-md" />
          <span className="sr-only">{t.common.loading}</span>
        </div>
      ) : error ? (
        <Callout tone="danger">{labels.failedToLoad}</Callout>
      ) : data?.providers.length ? (
        data.providers.map((providerMetrics) => (
          <SettingsSection
            key={providerMetrics.provider}
            padded
            title={t.providers[providerMetrics.provider]}
            action={
              <span className="text-sm text-fg-muted">
                {labels.totalProbeTimeoutsLabel.replace(
                  '{value}',
                  String(providerMetrics.totalProbeTimeouts)
                )}
              </span>
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

            <section className={BLOCK}>
              <MicroLabel as="h4" className="block">
                {labels.cacheSectionTitle}
              </MicroLabel>
              <CacheMetricsTable
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
        <EmptyState title={labels.empty} />
      )}
    </SettingsPage>
  );
}
