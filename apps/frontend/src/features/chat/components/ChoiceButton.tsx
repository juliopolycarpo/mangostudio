import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { ICON_SM } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';

interface ChoiceButtonProps {
  readonly selected: boolean;
  readonly disabled?: boolean;
  /** What holds the leading column until the choice is picked: a letter, an empty circle. */
  readonly marker?: ReactNode;
  readonly onClick: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * One answer the user can pick on a question or form card.
 *
 * A bordered `rounded-sm` row — it is clickable — whose picked state is the
 * neutral selected fill plus a check in the accent, the way a list's current
 * item reads everywhere else. The leading column is always reserved, so the
 * label does not move when the mark appears. A read-only card (already answered)
 * keeps full-strength text: the pick is the record, and fading it would make the
 * history harder to read, not the card more inert.
 *
 * // Usage: <ChoiceButton selected={picked} marker="a)" onClick={pick}>{label}</ChoiceButton>
 */
export function ChoiceButton({
  selected,
  disabled = false,
  marker,
  onClick,
  className,
  children,
}: ChoiceButtonProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm border border-stroke px-3 py-2 text-left text-sm transition-colors enabled:cursor-pointer disabled:cursor-default',
        selected ? 'bg-fill-selected' : 'enabled:hover:bg-fill-hover',
        className
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center text-xs font-medium',
          selected ? 'text-accent-fg' : 'text-fg-muted'
        )}
      >
        {selected ? <Check size={ICON_SM} /> : marker}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}
