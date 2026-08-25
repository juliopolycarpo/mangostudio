/**
 * A context ring with its figures a hover away.
 *
 * Both composers read the same way through this: the strip carries one ring,
 * and the numbers behind it — token counts, the window, whichever scopes the
 * runner reports — open on hover or on keyboard focus. Spelling them out inline
 * cost a whole wrapped line of the status strip to say something you read once
 * a session.
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
        data-percent={hasRing ? String(Math.round(ratio * 100)) : undefined}
        data-severity={severity}
        className="composer-chip cursor-default px-1"
      >
        {hasRing ? (
          <ContextRing ratio={ratio} severity={severity} />
        ) : (
          <span aria-hidden="true" className="tabular-nums text-[11px]">
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
        // Not `.dropdown-panel`: that rule is unlayered, so its 1rem radius
        // outranks any Tailwind utility here and reads as a pill on a panel
        // this short.
        className="pointer-events-none invisible absolute bottom-full right-0 z-50 mb-1.5 w-max max-w-[min(22rem,80vw)] rounded-lg border border-outline-variant/25 bg-surface-container-high px-2.5 py-2 opacity-0 shadow-lg transition-opacity duration-150 group-focus-within:visible group-focus-within:opacity-100 group-hover:visible group-hover:opacity-100"
      >
        <span className="flex flex-col gap-0.5 font-mono text-[11px] leading-4 text-on-surface-variant tabular-nums">
          {lines.map((line) => (
            <span key={line.key} data-testid={line.testId}>
              <span className="opacity-70">{`${line.label}: `}</span>
              {line.value}
            </span>
          ))}
        </span>
      </span>
    </span>
  );
}
