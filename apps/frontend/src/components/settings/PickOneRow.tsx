import type { ReactNode } from 'react';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { cn } from '@/lib/utils';

interface PickOneRowProps {
  /** Shared by every row of the list: it is what makes them one radio group. */
  readonly name: string;
  readonly checked: boolean;
  readonly onSelect: () => void;
  /** A 16px glyph at the start of the row. */
  readonly icon: ReactNode;
  /** What the choice is called (`text-sm`, 500 while current). */
  readonly title: ReactNode;
  /** One line under the name (`text-xs`, `fg-muted`). */
  readonly description?: ReactNode;
  /**
   * `true` when the list sits straight on the page (`surface` rows); the default is a
   * list inside a card or a dialog, where the rows are `control` fields.
   */
  readonly onCanvas?: boolean;
  /**
   * A choice that is listed but cannot be taken (a distribution another
   * environment already owns). It stays readable, loses its hover and cannot be
   * focused, and the cursor says so.
   */
  readonly disabled?: boolean;
}

/**
 * One row of a list where exactly one entry is current: an agent to edit, the
 * place a key is stored. The current one wears the navigation's mark — a neutral
 * `fill-selected` and the 3px `accent` bar on the leading edge — so the accent
 * says "this one" without turning the list into a field of mango.
 *
 * The row is a `<label>` around a visually hidden radio, so the group is a real
 * radio group: one tab stop, the arrow keys move the choice, and a screen reader
 * hears "radio, 2 of 3, selected" instead of a set of independent toggles. Wrap
 * the rows in `role="radiogroup"` with an `aria-label` that names the choice.
 *
 * // Usage:
 * <div role="radiogroup" aria-label={s.saveToLabel} className="grid gap-2">
 *   <PickOneRow name="source" checked={on} onSelect={pick} icon={<Database size={ICON_MD} />} title={s.label} description={s.hint} />
 * </div>
 */
export function PickOneRow({
  name,
  checked,
  onSelect,
  icon,
  title,
  description,
  onCanvas = false,
  disabled = false,
}: PickOneRowProps) {
  return (
    <label
      className={cn(
        'relative flex w-full items-center gap-3 rounded-sm border border-stroke px-3 py-2 text-left transition-colors',
        !disabled && 'cursor-pointer',
        'has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus',
        checked
          ? cn('bg-fill-selected', SELECTION_BAR)
          : onCanvas
            ? cn('bg-surface', !disabled && 'hover:bg-fill-hover')
            : cn('bg-control', !disabled && 'hover:bg-control-hover'),
        disabled && 'cursor-not-allowed opacity-50'
      )}
    >
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="sr-only"
      />
      <span className="shrink-0 text-fg-muted" aria-hidden="true">
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-sm text-fg', checked ? 'font-medium' : null)}>
          {title}
        </span>
        {description ? (
          <span className="block truncate text-xs text-fg-muted">{description}</span>
        ) : null}
      </span>
    </label>
  );
}
