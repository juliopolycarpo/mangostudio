import { CircleCheck, CircleX, Info, TriangleAlert } from 'lucide-react';
import type { HTMLAttributes, ReactNode } from 'react';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

type CalloutTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface CalloutProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  tone?: CalloutTone;
  /** Replaces the tone's default glyph; pass `null` to draw none. */
  icon?: ReactNode | null;
  /** One line that says what happened, in `fg` at weight 500. */
  title?: ReactNode;
  /** A button or link that offers the way out. */
  action?: ReactNode;
  children?: ReactNode;
}

const TONE: Record<CalloutTone, { box: string; icon: string; glyph: ReactNode }> = {
  neutral: { box: 'bg-fill-selected', icon: 'text-fg-muted', glyph: <Info size={ICON_MD} /> },
  info: { box: 'bg-info-subtle', icon: 'text-info', glyph: <Info size={ICON_MD} /> },
  success: {
    box: 'bg-success-subtle',
    icon: 'text-success',
    glyph: <CircleCheck size={ICON_MD} />,
  },
  warning: {
    box: 'bg-warning-subtle',
    icon: 'text-warning',
    glyph: <TriangleAlert size={ICON_MD} />,
  },
  danger: { box: 'bg-danger-subtle', icon: 'text-danger', glyph: <CircleX size={ICON_MD} /> },
};

/**
 * An inline notice: a tinted band, a glyph in the status colour, and text in
 * the ordinary text colours. The tone lives in the fill and the glyph, never in
 * a coloured border or in the words — and the glyph is what keeps it from being
 * colour alone.
 *
 * // Usage: <Callout tone="warning" title={t.context.nearLimit}>{t.context.hint}</Callout>
 */
export function Callout({
  tone = 'neutral',
  icon,
  title,
  action,
  className,
  children,
  ...props
}: CalloutProps) {
  const style = TONE[tone];
  return (
    <div
      className={cn('flex items-start gap-3 rounded-md p-3 text-sm', style.box, className)}
      {...props}
    >
      {icon === null ? null : (
        <span aria-hidden="true" className={cn('mt-0.5 shrink-0', style.icon)}>
          {icon ?? style.glyph}
        </span>
      )}
      <div className="min-w-0 flex-1 space-y-1">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className="text-fg-muted">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
