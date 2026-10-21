import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type EmptyStateTone = 'neutral' | 'success' | 'warning' | 'error';

/**
 * The icon's colour. A neutral icon is `fg-subtle`, a step quieter than the
 * title beside it, which is `fg`: the glyph is decoration, the words are the
 * message. The three status tones carry their meaning in the colour.
 */
const toneStyles: Record<EmptyStateTone, string> = {
  neutral: 'text-fg-subtle',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
};

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  hint?: string;
  tone?: EmptyStateTone;
  /** Buttons or links that offer the way out of the empty state. */
  action?: ReactNode;
  className?: string;
}

/** Centered icon + title + hint block for empty lists, clean trees, no-result searches. */
export function EmptyState({
  icon,
  title,
  hint,
  tone = 'neutral',
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex min-h-40 flex-col items-center justify-center gap-3 px-3 py-6 text-center',
        className
      )}
    >
      {icon ? <span className={toneStyles[tone]}>{icon}</span> : null}
      <div className="space-y-1">
        <p className="text-sm font-medium text-fg">{title}</p>
        {hint ? <p className="mx-auto max-w-xs text-xs text-fg-muted">{hint}</p> : null}
      </div>
      {action}
    </div>
  );
}
