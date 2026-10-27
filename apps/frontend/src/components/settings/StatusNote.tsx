import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes } from 'react';

import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

type StatusNoteTone = 'success' | 'warning' | 'danger' | 'info';

const TONE = {
  success: { Glyph: CircleCheck, color: 'text-success' },
  warning: { Glyph: TriangleAlert, color: 'text-warning' },
  danger: { Glyph: CircleX, color: 'text-danger' },
  info: { Glyph: Info, color: 'text-info' },
} as const;

interface StatusNoteProps extends HTMLAttributes<HTMLElement> {
  readonly tone: StatusNoteTone;
  /** `span` where the note sits inside a `<label>` or other phrasing-only parent. */
  readonly as?: 'p' | 'span';
}

/**
 * A one-line result inside a row or a card: a glyph in the status colour and the
 * words in the ordinary muted text. For a notice the user has to act on, use a
 * `Callout`; this is the quiet kind that sits beside what it reports on — a test
 * result, a skipped entry, a read that failed.
 *
 * // Usage: <StatusNote tone="danger" role="status">{message}</StatusNote>
 */
export function StatusNote({
  tone,
  as: Tag = 'p',
  className,
  children,
  ...props
}: StatusNoteProps) {
  const { Glyph, color } = TONE[tone];
  return (
    <Tag className={cn('flex items-start gap-1.5 text-xs text-fg-muted', className)} {...props}>
      <Glyph size={ICON_SM} aria-hidden="true" className={cn('mt-px shrink-0', color)} />
      <span className="min-w-0 break-words">{children}</span>
    </Tag>
  );
}
