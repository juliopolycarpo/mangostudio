import type { ChatGptUsageStats } from '@mangostudio/shared/connectors';
import type { Locale, Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, ChevronDown, RefreshCw, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { getChatGptUsageStats } from '../api';

type ConnectorMessages = Messages['settings']['connectors'];
type DailyUsageBucket = NonNullable<ChatGptUsageStats['dailyUsage']>[number];

const MAX_DAILY_BUCKETS = 30;
const QUERY_STALE_MS = 60_000;

const statsQueryKey = (connectorId: string) => ['chatgpt-usage-stats', connectorId] as const;

export function formatTokenCount(value: number, locale: Locale): string {
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
    <div className="min-w-0 rounded-lg border border-outline-variant/10 bg-surface-container-high/50 px-2.5 py-2">
      <p className="truncate text-[10px] font-medium text-on-surface-variant/55">{label}</p>
      <p className="mt-0.5 truncate font-mono text-sm text-on-surface">{value}</p>
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
      <p className="text-[10px] font-medium uppercase text-on-surface-variant/55">
        {s.chatgptStatsChartTitle}
      </p>
      <div
        role="img"
        aria-label={s.chatgptStatsChartTitle}
        className="flex h-20 items-end gap-1 rounded-lg border border-outline-variant/10 bg-surface-container-high/35 px-2 py-2"
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
              className="min-w-1 flex-1 rounded-sm bg-primary/65"
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
    return <p className="text-[11px] text-on-surface-variant/60">{s.chatgptStatsEmpty}</p>;
  }

  const streakValue = (days: number) =>
    s.chatgptStatsStreakValue.replace('{days}', formatTokenCount(days, locale));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
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
      </div>
      {dailyUsage.length > 0 && <UsageStatsChart buckets={dailyUsage} locale={locale} s={s} />}
    </div>
  );
}

export function ChatGptUsageStatsPanel({ connectorId }: { connectorId: string }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const [isOpen, setIsOpen] = useState(false);
  const panelId = `chatgpt-usage-stats-${connectorId}`;
  const statsQuery = useQuery({
    queryKey: statsQueryKey(connectorId),
    queryFn: () => getChatGptUsageStats(connectorId),
    enabled: isOpen,
    staleTime: QUERY_STALE_MS,
  });

  return (
    <div className="mt-1.5 max-w-xs space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setIsOpen((current) => !current)}
        aria-expanded={isOpen}
        aria-controls={panelId}
        className="px-2"
      >
        <BarChart3 size={14} />
        {s.chatgptStatsToggle}
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </Button>

      {isOpen && (
        <div
          id={panelId}
          className="space-y-3 rounded-xl border border-outline-variant/10 bg-surface-container-low px-3 py-3"
        >
          {statsQuery.isLoading || statsQuery.isFetching ? (
            <p className="flex items-center gap-2 text-[11px] text-on-surface-variant/60">
              <RefreshCw size={13} className="animate-spin" />
              {s.chatgptStatsLoading}
            </p>
          ) : statsQuery.isError ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-[11px] text-error">
                <TriangleAlert size={13} />
                {s.failedToLoad}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void statsQuery.refetch()}>
                <RefreshCw size={13} />
                {t.common.retry}
              </Button>
            </div>
          ) : (
            <StatsBody stats={statsQuery.data?.stats ?? null} locale={locale} s={s} />
          )}
        </div>
      )}
    </div>
  );
}
