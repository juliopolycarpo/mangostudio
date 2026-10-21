import type { ChatGptUsageStats } from '@mangostudio/shared/connectors';
import type { Locale, Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { getChatGptUsageStats } from '../api';

type ConnectorMessages = Messages['settings']['connectors'];
type DailyUsageBucket = NonNullable<ChatGptUsageStats['dailyUsage']>[number];

const MAX_DAILY_BUCKETS = 30;
const QUERY_STALE_MS = 60_000;
const QUERY_REFETCH_MS = 60_000;

const statsQueryKey = (connectorId: string) => ['chatgpt-usage-stats', connectorId] as const;

function formatTokenCount(value: number, locale: Locale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Math.round(value));
}

function formatDayLabel(startDate: string, locale: Locale): string {
  const date = new Date(`${startDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return startDate;
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
}

/** Compact turn duration with second granularity: "45s", "5m 20s", "1h 5m". */
function formatTurnDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const restSeconds = seconds % 60;
    return restSeconds > 0 ? `${minutes}m ${restSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

function normalizeDailyUsage(stats: ChatGptUsageStats): DailyUsageBucket[] {
  return (stats.dailyUsage ?? [])
    .filter((bucket) => Number.isFinite(bucket.tokens))
    .map((bucket) => ({
      startDate: String(bucket.startDate),
      tokens: Math.max(0, bucket.tokens),
    }))
    .sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))
    .slice(-MAX_DAILY_BUCKETS);
}

function hasStats(stats: ChatGptUsageStats, dailyUsage: DailyUsageBucket[]): boolean {
  return (
    stats.lifetimeTokens !== undefined ||
    stats.peakDailyTokens !== undefined ||
    stats.longestRunningTurnSec !== undefined ||
    stats.currentStreakDays !== undefined ||
    stats.longestStreakDays !== undefined ||
    dailyUsage.length > 0
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-fg-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-sm text-fg">{value}</dd>
    </div>
  );
}

function UsageStatsChart({
  buckets,
  locale,
  s,
}: {
  buckets: DailyUsageBucket[];
  locale: Locale;
  s: ConnectorMessages;
}) {
  const maxTokens = Math.max(...buckets.map((bucket) => bucket.tokens), 0);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-fg-muted">{s.chatgptStatsChartTitle}</p>
      {/* The bars are the accent's text variant, the one that clears 3:1 on a
          white surface; the baseline is the plot's only frame. */}
      <div
        role="img"
        aria-label={s.chatgptStatsChartTitle}
        className="flex h-20 items-end gap-1 border-b border-stroke"
      >
        {buckets.map((bucket) => {
          const percent = maxTokens > 0 ? (bucket.tokens / maxTokens) * 100 : 0;
          const day = formatDayLabel(bucket.startDate, locale);
          const tokens = formatTokenCount(bucket.tokens, locale);
          const label = s.chatgptStatsDayTokens.replace('{date}', day).replace('{tokens}', tokens);

          return (
            <div
              key={`${bucket.startDate}:${bucket.tokens}`}
              title={label}
              className="min-w-1 flex-1 rounded-t-xs bg-accent-fg"
              style={{ height: bucket.tokens > 0 ? `${Math.max(8, percent)}%` : '2px' }}
            >
              <span className="sr-only">{label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatsBody({
  stats,
  locale,
  s,
}: {
  stats: ChatGptUsageStats | null;
  locale: Locale;
  s: ConnectorMessages;
}) {
  const dailyUsage = useMemo(() => (stats ? normalizeDailyUsage(stats) : []), [stats]);
  if (!stats || !hasStats(stats, dailyUsage)) {
    return <p className="text-xs text-fg-muted">{s.chatgptStatsEmpty}</p>;
  }

  const streakValue = (days: number) =>
    s.chatgptStatsStreakValue.replace('{days}', formatTokenCount(days, locale));

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
        {stats.lifetimeTokens !== undefined && (
          <StatCell
            label={s.chatgptStatsLifetime}
            value={formatTokenCount(stats.lifetimeTokens, locale)}
          />
        )}
        {stats.peakDailyTokens !== undefined && (
          <StatCell
            label={s.chatgptStatsPeakDay}
            value={formatTokenCount(stats.peakDailyTokens, locale)}
          />
        )}
        {stats.longestRunningTurnSec !== undefined && (
          <StatCell
            label={s.chatgptStatsLongestTurn}
            value={formatTurnDuration(stats.longestRunningTurnSec)}
          />
        )}
        {stats.currentStreakDays !== undefined && (
          <StatCell
            label={s.chatgptStatsCurrentStreak}
            value={streakValue(stats.currentStreakDays)}
          />
        )}
        {stats.longestStreakDays !== undefined && (
          <StatCell
            label={s.chatgptStatsLongestStreak}
            value={streakValue(stats.longestStreakDays)}
          />
        )}
      </dl>
      {dailyUsage.length > 0 && <UsageStatsChart buckets={dailyUsage} locale={locale} s={s} />}
    </div>
  );
}

/**
 * Account-level usage stats for a ChatGPT connector: lifetime tokens, peak day,
 * longest turn, streaks, and a 30-day token chart. Rendered expanded on the
 * metrics card; the stats snapshot is polled in the background.
 */
export function ChatGptUsageStatsPanel({ connectorId }: { connectorId: string }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const statsQuery = useQuery({
    queryKey: statsQueryKey(connectorId),
    queryFn: () => getChatGptUsageStats(connectorId),
    staleTime: QUERY_STALE_MS,
    refetchInterval: QUERY_REFETCH_MS,
  });

  return (
    <section className="space-y-3">
      <MicroLabel as="h4" className="flex items-center gap-1.5">
        <BarChart3 size={ICON_SM} />
        {s.chatgptStatsToggle}
      </MicroLabel>

      {statsQuery.isLoading ? (
        <div role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          {s.chatgptStatsLoading}
        </div>
      ) : statsQuery.isError ? (
        <Callout
          tone="danger"
          action={
            <Button variant="subtle" size="sm" onClick={() => void statsQuery.refetch()}>
              <RefreshCw size={ICON_SM} />
              {t.common.retry}
            </Button>
          }
        >
          {s.failedToLoad}
        </Callout>
      ) : (
        <StatsBody stats={statsQuery.data?.stats ?? null} locale={locale} s={s} />
      )}
    </section>
  );
}
