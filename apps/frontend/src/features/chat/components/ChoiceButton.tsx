import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Whether picking this answer replaces the question's answer or adds to it. */
type ChoiceKind = 'one' | 'several';

interface ChoiceButtonProps {
  readonly selected: boolean;
  /** `one` draws a round face, `several` a square one — the `Radio` and `Checkbox` shapes. */
  readonly kind: ChoiceKind;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly className?: string;
  readonly children: ReactNode;
}

/**
 * One answer the user can pick on a question or form card.
 *
 * A bordered `rounded-sm` row — it is clickable — whose leading face says
 * what a click does before it is made: a circle where the question takes one
 * answer and a square where it takes several, the faces `Radio` and `Checkbox`
 * draw, so a pick-one and a pick-several question no longer look alike. Picked,
 * the face fills with the accent (a dot in the circle, a tick in the square) and
 * the row takes the neutral selected fill, the way a list's current item reads
 * everywhere else. A read-only card (already answered) keeps full-strength text:
 * the pick is the record, and fading it would make the history harder to read,
 * not the card more inert.
 *
 * `aria-pressed` carries the pick for a screen reader, which the fill and the
 * face do not. A card names its group (a `fieldset` labelled by the question),
 * so a pressed button reads as one answer among its siblings.
 *
 * // Usage: <ChoiceButton kind="one" selected={picked} onClick={pick}>{label}</ChoiceButton>
 */
export function ChoiceButton({
  selected,
  kind,
  disabled = false,
  onClick,
  className,
  children,
}: ChoiceButtonProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex w-full items-start gap-2 rounded-sm border border-stroke px-3 py-2 text-left text-sm transition-colors enabled:cursor-pointer disabled:cursor-default',
        selected ? 'bg-fill-selected' : 'enabled:hover:bg-fill-hover',
        className
      )}
    >
      {/* `mt-0.5` sits the 16px face on the first 20px line of the label. */}
      <span
        aria-hidden="true"
        data-choice-kind={kind}
        className={cn(
          'mt-0.5 flex size-4 shrink-0 items-center justify-center border transition-colors',
          kind === 'one' ? 'rounded-full' : 'rounded-xs',
          selected
            ? 'border-accent bg-accent text-on-accent'
            : 'border-stroke-strong bg-control text-transparent'
        )}
      >
        {kind === 'one' ? (
          <span className={cn('size-1.5 rounded-full', selected ? 'bg-on-accent' : null)} />
        ) : (
          <Check size={12} strokeWidth={3} />
        )}
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </button>
  );
}
