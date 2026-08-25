/**
 * External token usage as one ring on the composer strip.
 *
 * The figures used to be spelled out inline, which cost a whole wrapped line
 * of the status bar to tell you something you look at once a session. The ring
 * carries the one number that changes a decision — how full the window is —
 * and the breakdown stays a hover or a focus away, in the same `key: value`
 * dialect it always read in.
 *
 * Only fields the vendor reported are shown, and a vendor that reports no
 * window gets the compact total instead of a percentage: absent is not zero,
 * and a made-up denominator is worse than no ring.
 */

import type { ExternalThreadUsage, ExternalUsage } from '@mangostudio/shared/external-agents';
import { externalContextUsage, externalReportedTokens } from '@mangostudio/shared/external-agents';
import type { Messages } from '@mangostudio/shared/i18n';
import { ContextRing } from '@/components/ui/ContextRing';
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

  // The whole breakdown, for anyone who will never hover it.
  const accessibleName = [
    labels.indicatorLabel,
    turnLine === null ? null : `${labels.turnLabel}: ${turnLine}`,
    threadLine === null ? null : `${labels.threadLabel}: ${threadLine}`,
    `${labels.contextLabel}: ${contextLine}`,
  ]
    .filter((line): line is string => line !== null)
    .join('. ');

  // Without a window there is no percentage to draw, so the fallback is the
  // one figure that still means something on its own.
  const fallbackScope = thread?.total ?? turn;
  const fallback = fallbackScope ? externalReportedTokens(fallbackScope) : null;

  return (
    <span className="group relative inline-flex items-center" data-testid="external-usage">
      {/* A button rather than a bare span so the panel is reachable by
          keyboard: it opens on `:focus-within`, and nothing non-interactive
          ever takes that focus. It has no click of its own — hover and focus
          are the whole interaction. */}
      <button
        type="button"
        aria-label={accessibleName}
        data-testid="external-usage-indicator"
        data-percent={context ? String(context.percent) : undefined}
        className="composer-chip cursor-default px-1"
      >
        {context ? (
          <ContextRing ratio={context.ratio} severity={context.severity} size={18} />
        ) : (
          <span aria-hidden="true" className="tabular-nums text-[11px]">
            {fallback === null ? '—' : formatTokensCompact(fallback)}
          </span>
        )}
      </button>

      <span
        // Hidden from assistive tech rather than wired up as a description:
        // every word in it is already in the button's own name, and a reader
        // that announced both would say the whole breakdown twice.
        aria-hidden="true"
        // Opens above and grows leftward: the strip is the composer's top edge
        // — a panel below it would land on the textarea the user is about to
        // type into — and usage is the strip's last chip, so anchoring left
        // would push the panel off the right of the window.
        // Not `.dropdown-panel`: that rule is unlayered, so its 1rem radius
        // outranks any Tailwind utility here and reads as a pill on a panel
        // this short.
        className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-1.5 w-max max-w-[min(22rem,80vw)] rounded-lg border border-outline-variant/25 bg-surface-container-high px-2.5 py-2 opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <span className="flex flex-col gap-0.5 font-mono text-[11px] leading-4 text-on-surface-variant tabular-nums">
          {turnLine === null ? null : (
            <span data-testid="external-usage-turn">
              <span className="opacity-70">{`${labels.turnLabel}: `}</span>
              {turnLine}
            </span>
          )}
          {threadLine === null ? null : (
            <span data-testid="external-usage-thread">
              <span className="opacity-70">{`${labels.threadLabel}: `}</span>
              {threadLine}
            </span>
          )}
          <span data-testid="external-usage-context">
            <span className="opacity-70">{`${labels.contextLabel}: `}</span>
            {contextLine}
          </span>
        </span>
      </span>
    </span>
  );
}
