/**
 * Quiet account-quota chip for the runner selector: a neutral badge with the
 * figures in mono, so it matches the header's pill.
 *
 * Escalates visually only near exhaustion. Never disables the row on a zero
 * primary alone — secondary windows, credits and freshness are considered.
 * Missing or stale data renders as unknown, never as zero.
 */

import type { ExternalAccountLimits } from '@mangostudio/shared/external-agents';
import { interpretExternalAccountLimits } from '@mangostudio/shared/external-agents/values';
import { RefreshCw } from 'lucide-react';

import { Badge } from '@/components/ui/Badge';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

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

  // A snapshot too old to trust reads neutral here rather than as a warning: the
  // selector's row already carries the agent's real refusals, and colouring
  // "we have not asked recently" like an exhausted account would outrank them.
  // `low` is only ever true for a fresh snapshot, so it alone picks the warning.
  return (
    <Badge
      variant={low ? 'warning' : 'neutral'}
      className="gap-1 font-mono"
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
          className="-mr-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm transition-colors hover:bg-fill-hover disabled:opacity-50"
        >
          <RefreshCw size={ICON_SM} className={cn(refreshing && 'animate-spin')} />
        </button>
      ) : null}
    </Badge>
  );
}
