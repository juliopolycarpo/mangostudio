/**
 * The frame the machine page's cards share: a flat `surface` with a hairline,
 * a `MicroLabel` heading with an optional status or control opposite it, an
 * optional headline answering "what state is it in", and the body below.
 * Six cards were each drawing this header by hand.
 *
 * Every card states its facts the same way, `MachineFacts` of `MachineFact`
 * rows: the name on the left, the value on the right, a hairline between. A
 * value is prose unless it is technical content (a path, an address, a pid). Two
 * layouts on one page (a row here, a stacked pair there) made the cards look
 * hand-built, and a stacked pair in a card as wide as the page left its value
 * hugging the left edge with nothing to meet it.
 *
 * // Usage: <MachineCard title={m.hub.title} headline={m.hub.running} testId="machine-hub-card">…</MachineCard>
 */

import type { ReactNode } from 'react';

import { MicroLabel } from '@/components/ui/MicroLabel';
import { cn } from '@/lib/utils';

import { FindingIcon } from '../../components/FindingList';
import { TOOL_CARD_SURFACE } from '../../components/ToolCard';

interface MachineCardProps {
  readonly title: string;
  /** The card's state in one line (`Running`, `Installed`), in section-title type. */
  readonly headline?: string;
  /** A line under the headline: what supervises it, what it is called. */
  readonly description?: string;
  /** A badge or button opposite the heading. */
  readonly action?: ReactNode;
  /**
   * The card's action, pinned to its foot under a hairline. Cards share a row of
   * the grid and stretch to its height, so this is what puts one card's action on
   * the same line as its neighbour's however short its body is.
   */
  readonly footer?: ReactNode;
  readonly testId: string;
  readonly children: ReactNode;
}

export function MachineCard({
  title,
  headline,
  description,
  action,
  footer,
  testId,
  children,
}: MachineCardProps) {
  return (
    <section
      className={cn(TOOL_CARD_SURFACE, 'flex flex-col gap-4 p-4 sm:p-6')}
      data-testid={testId}
    >
      <header className="space-y-1">
        {/* As tall as the badge that sits opposite the title in some cards, so the
            headline starts on the same line whether or not this one has an action. */}
        <div className="flex min-h-5 items-center justify-between gap-3">
          <MicroLabel as="h3">{title}</MicroLabel>
          {action}
        </div>
        {headline ? <p className="text-base font-semibold text-fg">{headline}</p> : null}
        {description ? <p className="text-sm text-fg-muted">{description}</p> : null}
      </header>
      {children}
      {footer ? <div className="mt-auto border-t border-stroke pt-4">{footer}</div> : null}
    </section>
  );
}

/** The facts of one card, a hairline between them. */
export function MachineFacts({ children }: { readonly children: ReactNode }) {
  return <dl className="divide-y divide-stroke">{children}</dl>;
}

/**
 * One run of a fact's value. `code` marks technical text — a path, an address,
 * a unit name — which is set in mono; everything else is prose in the interface
 * font. Runs are joined as given, so the caller writes its own separator.
 */
export interface MachineFactPart {
  readonly text: string;
  readonly code?: boolean;
}

interface MachineFactProps {
  readonly label: string;
  /**
   * The fact, right-aligned: a string, or parts when one value mixes a word and a
   * path. Left out when `children` is the fact (a badge).
   */
  readonly value?: string | readonly MachineFactPart[];
  /**
   * Set a string `value` in mono. Decided per value, not per row: several facts
   * are a path when there is one and a sentence when there is not, and only the
   * path is technical content.
   */
  readonly mono?: boolean;
  /** A glyph before the label when what it reports is wrong or worth a second look. */
  readonly severity?: 'warn' | 'fail';
  /** The release host's own text for a failed check — kept for a hover on the value, not shown as the sentence. */
  readonly title?: string;
  /** A status that is better said as a word in a badge than as mono text. */
  readonly children?: ReactNode;
}

/** Mono may break anywhere, since a path has no spaces to wrap at; prose wraps at words. */
const CODE_TEXT = 'break-all font-mono text-xs';

/**
 * One fact about the machine: the name in prose on the left, its value on the
 * right. Prose values are `text-sm` like the label, with tabular figures so a
 * duration does not jitter as it ticks; only technical content is mono.
 */
export function MachineFact({ label, value, mono, severity, title, children }: MachineFactProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm first:pt-0 last:pb-0">
      <dt className="flex shrink-0 items-baseline gap-2 text-fg-muted">
        {severity ? <FindingIcon severity={severity} /> : null}
        {label}
      </dt>
      <dd className="min-w-0 text-right">
        {children ??
          (typeof value === 'string' || value === undefined ? (
            <span
              className={cn('text-fg', mono ? CODE_TEXT : 'break-words tabular-nums')}
              title={title}
            >
              {value}
            </span>
          ) : (
            <span className="break-words text-fg tabular-nums" title={title}>
              {value.map((part, index) => (
                // eslint-disable-next-line react/no-array-index-key -- positional runs that never reorder
                <span key={index} className={part.code ? CODE_TEXT : undefined}>
                  {part.text}
                </span>
              ))}
            </span>
          ))}
      </dd>
    </div>
  );
}
