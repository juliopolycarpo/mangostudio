/**
 * Quiet account-quota chip for the runner selector.
 *
 * Escalates visually only near exhaustion. Never disables the row on a zero
 * primary alone — secondary windows, credits and freshness are considered.
 * Missing or stale data renders as unknown, never as zero.
 */

import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { interpretExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { RefreshCw } from 'lucide-react';
import { useI18n } from '@/hooks/use-i18n';

function formatCompactDuration(ms: number): string {
  const totalMinutes = Math.max(0, Math.round(ms / 60_000));
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 48) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function ExternalAccountLimitsChip({
  limits,
  nowMs = Date.now(),
  onRefresh,
  refreshing,
}: {
  limits: ExternalAccountLimits | null | undefined;
  nowMs?: number;
  onRefresh?: () => void;
  refreshing?: boolean;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.limits;
  const verdict = interpretExternalAccountLimits(limits, nowMs);

  let body: string;
  let tone: 'muted' | 'warn' | 'ok' = 'muted';

  switch (verdict.kind) {
    case 'unknown':
      body = labels.unknown;
      break;
    case 'stale':
      body = labels.stale;
      break;
    case 'ok': {
      const remaining = Math.max(0, 100 - verdict.tightest.usedPercent);
      body = labels.remaining.replace('{percent}', String(Math.round(remaining)));
      if (verdict.exhausted) {
        body = labels.exhausted;
        tone = 'warn';
        if (verdict.tightest.resetsAtMs !== undefined) {
          const delta = verdict.tightest.resetsAtMs - nowMs;
          if (delta > 0) {
            body = `${labels.exhausted} · ${labels.resetsIn.replace('{duration}', formatCompactDuration(delta))}`;
          }
        }
      } else if (remaining <= 15) {
        tone = 'warn';
      } else {
        tone = 'ok';
      }
      break;
    }
  }

  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] ${
        tone === 'warn'
          ? 'text-error'
          : tone === 'ok'
            ? 'text-on-surface-variant/70'
            : 'text-on-surface-variant/50'
      }`}
      data-testid="external-account-limits"
      data-verdict={verdict.kind}
      data-exhausted={verdict.kind === 'ok' && verdict.exhausted ? 'true' : 'false'}
    >
      <span>{body}</span>
      {onRefresh ? (
        <button
          type="button"
          aria-label={labels.refresh}
          disabled={refreshing}
          onClick={(event) => {
            event.stopPropagation();
            onRefresh();
          }}
          className="rounded p-0.5 hover:bg-surface-container-high disabled:opacity-50"
        >
          <RefreshCw size={10} className={refreshing ? 'animate-spin' : undefined} />
        </button>
      ) : null}
    </span>
  );
}
