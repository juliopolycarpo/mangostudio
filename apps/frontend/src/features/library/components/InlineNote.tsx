/**
 * One line of status text with its glyph: how a wizard step says "check at least
 * one destination" and how a row says "this backup could not be restored".
 *
 * The glyph carries the tone and the words stay in the ordinary text colours,
 * except for an error, which takes `danger` the way `Input` draws its own error
 * line. A notice that deserves a band and an action is a `Callout`, not this.
 *
 * // Usage: <InlineNote tone="warning">{l.destination.noneSelected}</InlineNote>
 */

import { CircleX, Info, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes } from 'react';

import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

type NoteTone = 'danger' | 'warning' | 'info';

const TONES = {
  danger: { Glyph: CircleX, glyph: 'text-danger', text: 'text-danger' },
  warning: { Glyph: TriangleAlert, glyph: 'text-warning', text: 'text-fg-muted' },
  info: { Glyph: Info, glyph: 'text-info', text: 'text-fg-muted' },
} as const;

interface InlineNoteProps extends HTMLAttributes<HTMLSpanElement> {
  readonly tone: NoteTone;
}

export function InlineNote({ tone, className, children, ...props }: InlineNoteProps) {
  const { Glyph, glyph, text } = TONES[tone];
  return (
    <span className={cn('flex items-start gap-1.5 text-xs', text, className)} {...props}>
      <Glyph size={ICON_SM} aria-hidden="true" className={cn('mt-px shrink-0', glyph)} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}
