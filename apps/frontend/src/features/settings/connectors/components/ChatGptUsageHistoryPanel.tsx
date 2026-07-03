import type { ChatGptUsageSample } from '@mangostudio/shared/connectors';
import type { Locale, Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, History, RefreshCw, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { useI18n } from '@/hooks/use-i18n';
import { getChatGptUsageHistory } from '../api';

type ConnectorMessages = Messages['settings']['connectors'];

const HISTORY_DAYS = 7;
const QUERY_STALE_MS = 60_000;

/** Sparkline geometry (viewBox units). */
const CHART_WIDTH = 300;
const CHART_HEIGHT = 72;
const CHART_PAD_Y = 6;

const historyQueryKey = (connectorId: string) =>
  ['chatgpt-usage-history', connectorId, HISTORY_DAYS] as const;

function formatSampleTime(sampledAt: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(sampledAt));
}

interface ChartPoint {
  x: number;
  y: number;
  sample: ChatGptUsageSample;
  /** True when this sample starts a fresh window (usage dropped). */
  resetBoundary: boolean;
}

/** Maps samples onto the viewBox: x spans the requested days ending now. */
function toChartPoints(samples: ChatGptUsageSample[], now: number): ChartPoint[] {
  const start = now - HISTORY_DAYS * 24 * 60 * 60_000;
  const span = now - start;
  const plotHeight = CHART_HEIGHT - CHART_PAD_Y * 2;

  return samples.map((sample, index) => {
    const previous = samples[index - 1];
    const usedPercent = Math.min(100, Math.max(0, sample.usedPercent));
    return {
      x: ((Math.max(sample.sampledAt, start) - start) / span) * CHART_WIDTH,
      y: CHART_HEIGHT - CHART_PAD_Y - (usedPercent / 100) * plotHeight,
      sample,
      resetBoundary: previous !== undefined && sample.usedPercent < previous.usedPercent,
    };
  });
}

function UsageHistoryChart({
  samples,
  locale,
  s,
}: {
  samples: ChatGptUsageSample[];
  locale: Locale;
  s: ConnectorMessages;
}) {
  const title = s.chatgptHistoryChartTitle.replace('{days}', String(HISTORY_DAYS));
  const points = toChartPoints(samples, Date.now());
  const linePath = points.map((p) => `${p.x},${p.y}`).join(' ');
  const firstPoint = points[0];
  const lastPoint = points[points.length - 1];
  const areaPath =
    firstPoint && lastPoint
      ? `${firstPoint.x},${CHART_HEIGHT - CHART_PAD_Y} ${linePath} ${lastPoint.x},${CHART_HEIGHT - CHART_PAD_Y}`
      : '';

  return (
    <div className="space-y-2">
      <p className="text-[10px] font-medium uppercase text-on-surface-variant/55">{title}</p>
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-20 w-full rounded-lg border border-outline-variant/10 bg-surface-container-high/35"
        preserveAspectRatio="none"
      >
        {points.length > 1 && (
          <polygon points={areaPath} className="fill-primary/15" stroke="none" />
        )}
        {points.length > 1 && (
          <polyline
            points={linePath}
            fill="none"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            className="stroke-primary/70"
          />
        )}
        {points
          .filter((point) => point.resetBoundary)
          .map((point) => (
            <line
              key={`reset-${point.sample.sampledAt}`}
              x1={point.x}
              y1={CHART_PAD_Y}
              x2={point.x}
              y2={CHART_HEIGHT - CHART_PAD_Y}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
              className="stroke-outline-variant/60"
            />
          ))}
        {points.map((point) => {
          const label = s.chatgptHistoryPoint
            .replace('{time}', formatSampleTime(point.sample.sampledAt, locale))
            .replace('{percent}', String(Math.round(point.sample.usedPercent)));
          return (
            <circle
              key={point.sample.sampledAt}
              cx={point.x}
              cy={point.y}
              r={3}
              className="fill-primary/80"
            >
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>
      <p className="text-[10px] text-on-surface-variant/50">{s.chatgptHistoryDisclaimer}</p>
    </div>
  );
}

/**
 * Collapsible weekly-window usage history for a ChatGPT connector: a sparkline
 * of the persisted used-percent samples with reset boundaries marked.
 */
export function ChatGptUsageHistoryPanel({ connectorId }: { connectorId: string }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const [isOpen, setIsOpen] = useState(false);
  const panelId = `chatgpt-usage-history-${connectorId}`;
  const historyQuery = useQuery({
    queryKey: historyQueryKey(connectorId),
    queryFn: () => getChatGptUsageHistory(connectorId, { window: 'secondary', days: HISTORY_DAYS }),
    enabled: isOpen,
    staleTime: QUERY_STALE_MS,
  });
  const samples = historyQuery.data?.samples ?? [];

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
        <History size={14} />
        {s.chatgptHistoryToggle}
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </Button>

      {isOpen && (
        <div
          id={panelId}
          className="space-y-3 rounded-xl border border-outline-variant/10 bg-surface-container-low px-3 py-3"
        >
          {historyQuery.isLoading || historyQuery.isFetching ? (
            <p className="flex items-center gap-2 text-[11px] text-on-surface-variant/60">
              <RefreshCw size={13} className="animate-spin" />
              {s.chatgptHistoryLoading}
            </p>
          ) : historyQuery.isError ? (
            <div className="flex items-center justify-between gap-3">
              <p className="flex items-center gap-2 text-[11px] text-error">
                <TriangleAlert size={13} />
                {s.failedToLoad}
              </p>
              <Button variant="ghost" size="sm" onClick={() => void historyQuery.refetch()}>
                <RefreshCw size={13} />
                {t.common.retry}
              </Button>
            </div>
          ) : samples.length === 0 ? (
            <p className="text-[11px] text-on-surface-variant/60">{s.chatgptHistoryEmpty}</p>
          ) : (
            <UsageHistoryChart samples={samples} locale={locale} s={s} />
          )}
        </div>
      )}
    </div>
  );
}
