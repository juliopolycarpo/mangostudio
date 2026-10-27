/**
 * A context ring with its figures a hover away.
 *
 * Both composers read the same way through this: the strip carries one ring and
 * its percentage, and the numbers behind them — token counts, the window,
 * whichever scopes the runner reports — open on hover or on keyboard focus.
 * Spelling them out inline cost a whole wrapped line of the status strip to say
 * something you read once a session.
 */

import type { ContextSeverity } from '@mangostudio/shared/chat';
import type { ReactNode } from 'react';

import { ContextRing } from './ContextRing';

export interface ContextUsageLine {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly testId?: string;
}

interface ContextUsageChipProps {
  /** Omitted when nothing reports a window, which is when `fallback` shows instead. */
  readonly ratio?: number | null;
  readonly severity?: ContextSeverity;
  /** Stands in for the ring when there is no ratio to draw. */
  readonly fallback?: ReactNode;
  readonly lines: readonly ContextUsageLine[];
  /**
   * Leads the accessible name. Omit it where the first line already names the
   * chip — "Context. Context: 9,600 / 1,000,000 tokens" is one word too many.
   */
  readonly ariaLabelPrefix?: string;
  readonly testId?: string;
}

export function ContextUsageChip({
  ratio,
  severity = 'normal',
  fallback,
  lines,
  ariaLabelPrefix,
  testId,
}: ContextUsageChipProps) {
  const hasRing = typeof ratio === 'number' && Number.isFinite(ratio);
  const percent = hasRing ? Math.round(ratio * 100) : null;

  // The whole breakdown, for anyone who will never hover it.
  const accessibleName = [
    ...(ariaLabelPrefix ? [ariaLabelPrefix] : []),
    ...lines.map((line) => `${line.label}: ${line.value}`),
  ].join('. ');

  return (
    <span className="group relative inline-flex items-center" data-testid={testId}>
      {/* A button rather than a bare span so the panel is reachable by
          keyboard: it opens on `:focus-within`, and nothing non-interactive
          ever takes that focus. It has no click of its own — hover and focus
          are the whole interaction. */}
      <button
        type="button"
        aria-label={accessibleName}
        data-testid={testId ? `${testId}-indicator` : undefined}
        data-percent={percent === null ? undefined : String(percent)}
        data-severity={severity}
        className="composer-chip cursor-default"
      >
        {hasRing ? (
          <>
            {/* The figure is running text beside the ring, not a digit squeezed
                inside it: the strip has room for 12px, and the number is the
                reason anyone looks at this chip. */}
            <ContextRing ratio={ratio} severity={severity} showValue={false} />
            <span aria-hidden="true" className="tabular-nums">{`${percent}%`}</span>
          </>
        ) : (
          <span aria-hidden="true" className="tabular-nums">
            {fallback}
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
        //
        // `.dropdown-panel` is the surface (raised fill, hairline, 8px radius,
        // popover shadow, the stacking), the same one every menu on this strip
        // opens; what is spelt here is only where it sits and how it appears.
        // Not `ComposerPopover`: that docks on the composer shell, and this
        // panel belongs to its chip.
        className="dropdown-panel pointer-events-none invisible absolute bottom-full right-0 mb-1.5 w-max max-w-[min(22rem,80vw)] px-3 py-2 opacity-0 transition-opacity group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <span className="flex flex-col gap-0.5 font-mono text-micro text-fg-muted tabular-nums">
          {lines.map((line) => (
            <span key={line.key} data-testid={line.testId}>
              <span className="text-fg-subtle">{`${line.label}: `}</span>
              {line.value}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
