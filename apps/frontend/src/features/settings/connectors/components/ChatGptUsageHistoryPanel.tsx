import type { ChatGptUsageSample } from '@mangostudio/shared/connectors';
import type { Locale, Messages } from '@mangostudio/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { History, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Callout } from '@/components/ui/Callout';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { Spinner } from '@/components/ui/Spinner';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { getChatGptUsageHistory } from '../api';

type ConnectorMessages = Messages['settings']['connectors'];

const HISTORY_DAYS = 7;
const QUERY_STALE_MS = 60_000;
const QUERY_REFETCH_MS = 60_000;

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
      <p className="text-xs font-medium text-fg-muted">{title}</p>
      {/* Marks use the accent's text variant, which clears 3:1 on a white
          surface where the button fill does not; the area under the line is
          its translucent wash, so the series still reads against either theme. */}
      <svg
        role="img"
        aria-label={title}
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className="h-20 w-full border-b border-stroke"
        preserveAspectRatio="none"
      >
        {points.length > 1 && (
          <polygon points={areaPath} className="fill-accent-subtle" stroke="none" />
        )}
        {points.length > 1 && (
          <polyline
            points={linePath}
            fill="none"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            className="stroke-accent-fg"
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
              className="stroke-stroke-strong"
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
              className="fill-accent-fg"
            >
              <title>{label}</title>
            </circle>
          );
        })}
      </svg>
      <p className="text-xs text-fg-subtle">{s.chatgptHistoryDisclaimer}</p>
    </div>
  );
}

/**
 * Weekly-window usage history for a ChatGPT connector: a sparkline of the
 * persisted used-percent samples with reset boundaries marked. Rendered
 * expanded on the metrics card; the snapshot is polled in the background.
 */
export function ChatGptUsageHistoryPanel({ connectorId }: { connectorId: string }) {
  const { t, locale } = useI18n();
  const s = t.settings.connectors;
  const historyQuery = useQuery({
    queryKey: historyQueryKey(connectorId),
    queryFn: () => getChatGptUsageHistory(connectorId, { window: 'secondary', days: HISTORY_DAYS }),
    staleTime: QUERY_STALE_MS,
    refetchInterval: QUERY_REFETCH_MS,
  });
  const samples = historyQuery.data?.samples ?? [];

  return (
    <section className="space-y-3">
      <MicroLabel as="h4" className="flex items-center gap-1.5">
        <History size={ICON_SM} />
        {s.chatgptHistoryToggle}
      </MicroLabel>

      {historyQuery.isLoading ? (
        <div role="status" className="flex items-center gap-2 text-xs text-fg-muted">
          <Spinner size="sm" />
          {s.chatgptHistoryLoading}
        </div>
      ) : historyQuery.isError ? (
        <Callout
          tone="danger"
          action={
            <Button variant="subtle" size="sm" onClick={() => void historyQuery.refetch()}>
              <RefreshCw size={ICON_SM} />
              {t.common.retry}
            </Button>
          }
        >
          {s.failedToLoad}
        </Callout>
      ) : samples.length === 0 ? (
        <p className="text-xs text-fg-muted">{s.chatgptHistoryEmpty}</p>
      ) : (
        <UsageHistoryChart samples={samples} locale={locale} s={s} />
      )}
    </section>
  );
}
