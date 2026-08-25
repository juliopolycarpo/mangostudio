/**
 * External token usage as one ring on the composer strip.
 *
 * The scopes and their wording live here; the ring and its hover panel are
 * `ContextUsageChip`, which the MangoStudio runner's own context chip draws
 * through too — the strip should not read one way per runner.
 *
 * Only fields the vendor reported are shown, and a vendor that reports no
 * window gets the compact total instead of a percentage: absent is not zero,
 * and a made-up denominator is worse than no ring.
 */

import type { ExternalThreadUsage, ExternalUsage } from '@mangostudio/shared/external-agents';
import { externalContextUsage, externalReportedTokens } from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import type { ContextUsageLine } from '@/components/ui/ContextUsageChip';
import { ContextUsageChip } from '@/components/ui/ContextUsageChip';
import { useI18n } from '@/hooks/use-i18n';
import { formatMessage } from '@/lib/i18n-format';

type UsageLabels = Messages['externalAgents']['usage'];

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

/** `in 29k · out 1.2k · total 30k`, skipping whatever the vendor left out. */
function describeUsage(usage: ExternalUsage, labels: UsageLabels): string | null {
  const parts: string[] = [];
  if (usage.inputTokens !== undefined) {
    parts.push(`${labels.input} ${formatTokensCompact(usage.inputTokens)}`);
  }
  if (usage.outputTokens !== undefined) {
    parts.push(`${labels.output} ${formatTokensCompact(usage.outputTokens)}`);
  }
  if (usage.totalTokens !== undefined) {
    parts.push(`${labels.total} ${formatTokensCompact(usage.totalTokens)}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

export function ExternalUsageDisplay({
  turn,
  thread,
}: {
  turn?: ExternalUsage | null;
  thread?: ExternalThreadUsage | null;
}) {
  const { t } = useI18n();
  const labels = t.externalAgents.usage;

  const turnLine = turn ? describeUsage(turn, labels) : null;
  const threadLine = thread?.total ? describeUsage(thread.total, labels) : null;
  const context = externalContextUsage(thread);

  if (turnLine === null && threadLine === null) {
    return null;
  }

  const contextLine = context
    ? formatMessage(labels.contextValue, {
        used: formatTokensCompact(context.usedTokens),
        limit: formatTokensCompact(context.windowTokens),
        percent: String(context.percent),
      })
    : labels.contextUnknown;

  // Without a window there is no percentage to draw, so the fallback is the
  // one figure that still means something on its own.
  const fallbackScope = thread?.total ?? turn;
  const fallback = fallbackScope ? externalReportedTokens(fallbackScope) : null;

  const lines: ContextUsageLine[] = [];
  if (turnLine !== null) {
    lines.push({
      key: 'turn',
      label: labels.turnLabel,
      value: turnLine,
      testId: 'external-usage-turn',
    });
  }
  if (threadLine !== null) {
    lines.push({
      key: 'thread',
      label: labels.threadLabel,
      value: threadLine,
      testId: 'external-usage-thread',
    });
  }
  lines.push({
    key: 'context',
    label: labels.contextLabel,
    value: contextLine,
    testId: 'external-usage-context',
  });

  return (
    <ContextUsageChip
      ratio={context?.ratio}
      severity={context?.severity}
      fallback={fallback === null ? '\u2014' : formatTokensCompact(fallback)}
      lines={lines}
      ariaLabelPrefix={labels.indicatorLabel}
      testId="external-usage"
    />
  );
}
