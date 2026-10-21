/**
 * The frame the machine page's cards share: a flat `surface` with a hairline,
 * a `MicroLabel` heading with an optional status or control opposite it, an
 * optional headline answering "what state is it in", and the body below.
 * Six cards were each drawing this header by hand.
 *
 * Every card states its facts the same way, `MachineFacts` of `MachineFact`
 * rows: the name on the left, the value on the right, a hairline between. Two
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

interface MachineFactProps {
  readonly label: string;
  /** The fact in mono, right-aligned. Left out when `children` is the fact (a badge). */
  readonly value?: string;
  /** A glyph before the label when what it reports is wrong or worth a second look. */
  readonly severity?: 'warn' | 'fail';
  /** The release host's own text for a failed check — kept for a hover on the value, not shown as the sentence. */
  readonly title?: string;
  /** A status that is better said as a word in a badge than as mono text. */
  readonly children?: ReactNode;
}

/** One fact about the machine: the name in prose on the left, its value on the right. */
export function MachineFact({ label, value, severity, title, children }: MachineFactProps) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2 text-sm first:pt-0 last:pb-0">
      <dt className="flex shrink-0 items-baseline gap-2 text-fg-muted">
        {severity ? <FindingIcon severity={severity} /> : null}
        {label}
      </dt>
      <dd className="min-w-0 text-right">
        {children ?? (
          <span className="break-all font-mono text-xs text-fg" title={title}>
            {value}
          </span>
        )}
      </dd>
    </div>
  );
}
