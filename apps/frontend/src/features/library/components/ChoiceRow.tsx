/**
 * A selectable row: a checkbox or a radio, and whatever the choice needs to say.
 *
 * The whole row is the hit target (it is the control's `<label>`), so it is
 * clickable and takes the clickable radius. A checked row takes the neutral
 * selected fill and an unchecked one the hover fill; the accent lives only in the
 * control itself. A disabled row keeps its text at full strength — a blocked
 * destination still has to be readable — and lets the control and the reason
 * beside it say why nothing happens.
 *
 * // Usage:
 * <ChoiceRow control="checkbox" checked={on} onChange={toggle} bordered>…</ChoiceRow>
 */

import type { InputHTMLAttributes, ReactNode } from 'react';
import { Checkbox } from '@/components/ui/Checkbox';
import { Radio } from '@/components/ui/Radio';
import { cn } from '@/lib/utils';

/** `data-*` hooks (test ids, state) that belong to the row rather than to its input. */
interface RowData {
  readonly [key: `data-${string}`]: string | number | boolean | undefined;
}

interface ChoiceRowProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'className' | 'children'> {
  readonly control: 'checkbox' | 'radio';
  /** Hooks for the row's own element; every other prop goes to the input. */
  readonly row?: RowData;
  /** A hairline around the row, for rows that stand on their own rather than inside a card. */
  readonly bordered?: boolean;
  readonly children: ReactNode;
}

export function ChoiceRow({ control, row, bordered = false, children, ...input }: ChoiceRowProps) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is a checkbox or a radio picked by `control`, and either one is a child of this label.
    <label
      className={cn(
        'flex items-center gap-3 rounded-sm px-3 py-2 transition-colors',
        bordered && 'border border-stroke',
        input.disabled
          ? 'cursor-not-allowed'
          : cn('cursor-pointer', input.checked ? 'bg-fill-selected' : 'hover:bg-fill-hover')
      )}
      {...row}
    >
      {control === 'checkbox' ? <Checkbox {...input} /> : <Radio {...input} />}
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}
