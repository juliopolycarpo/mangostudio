/**
 * The two pieces both result panels are made of: a headed list, and a row that
 * says what happened to one copy with a glyph in the outcome's colour.
 *
 * The glyph is what keeps an outcome from being colour alone, and the row's words
 * stay in the ordinary text colours — a failed copy is a `CircleX` and the
 * reason, not red prose.
 *
 * // Usage:
 * <ResultSection heading={l.result.appliedHeading}>
 *   <ResultRow outcome="done" title={key} testId="applied-row">…</ResultRow>
 * </ResultSection>
 */

import { CircleCheck, CircleSlash, CircleX } from 'lucide-react';
import type { ReactNode } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

type Outcome = 'done' | 'failed' | 'kept';

const OUTCOMES = {
  done: { Glyph: CircleCheck, tone: 'text-success' },
  failed: { Glyph: CircleX, tone: 'text-danger' },
  kept: { Glyph: CircleSlash, tone: 'text-fg-muted' },
} as const;

export function ResultSection({
  heading,
  children,
}: {
  readonly heading: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <MicroLabel as="h3">{heading}</MicroLabel>
      <ul className="space-y-2">{children}</ul>
    </section>
  );
}

export function ResultRow({
  outcome,
  title,
  testId,
  children,
}: {
  readonly outcome: Outcome;
  readonly title: string;
  readonly testId: string;
  /** Detail lines under the title; each brings its own `block`. */
  readonly children?: ReactNode;
}) {
  const { Glyph, tone } = OUTCOMES[outcome];
  return (
    <li className="flex items-start gap-2" data-testid={testId}>
      <Glyph size={ICON_SM} aria-hidden="true" className={cn('mt-0.5 shrink-0', tone)} />
      <span className="min-w-0 space-y-0.5">
        <span className="block text-fg text-sm">{title}</span>
        {children}
      </span>
    </li>
  );
}
