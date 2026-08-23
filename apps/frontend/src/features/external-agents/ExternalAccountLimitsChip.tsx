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
import { describeAccountLimits } from './account-limits-copy';

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
  const { body, low } = describeAccountLimits(verdict, labels, nowMs);
  // A snapshot too old to trust reads muted here rather than as a warning: the
  // selector's row already carries the agent's real refusals, and colouring
  // "we have not asked recently" like an exhausted account would outrank them.
  const tone: 'muted' | 'warn' | 'ok' = verdict.kind !== 'ok' ? 'muted' : low ? 'warn' : 'ok';

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
