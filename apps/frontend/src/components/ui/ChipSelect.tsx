/**
 * A one-of-many picker that wears the composer's chip dialect.
 *
 * The composer's status line already had three hand-written dropdowns
 * (`ModelSelector`, `ThinkingToggle`, `PermissionSelector`) and four native
 * `<select>`s. The chips looked alike closed, but a native select opens an
 * OS-drawn list — square, system-font, system-coloured — in the middle of a
 * strip whose other menus open a `dropdown-panel`. There is no CSS fix for
 * that: `option` is not styleable to this degree in any engine we ship to, so
 * the control itself has to go.
 *
 * This is the shared replacement rather than a fourth bespoke one. It keeps the
 * `role="combobox"` the native element had, so `getByRole('combobox', { name })`
 * still addresses it, and the value is read from the trigger's text rather than
 * from a form value.
 *
 * Opens upward by default: the composer sits at the foot of the viewport, which
 * is the same reason `ModelSelector` and `ThinkingToggle` do. A chip placed
 * near the top of the page — the environment chip in the header, or in a page's
 * title row — passes `placement="below"`, because an upward panel there opens
 * above the viewport and is clipped away entirely.
 *
 * The rows are the same 14px / 12px pair `Select` and `Menu` draw, so two menus
 * opened from the same strip do not differ in type size.
 */

import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useId } from 'react';
import { type ListboxOption, useListboxSelect } from '@/hooks/use-listbox-select';
import { ICON_MD, ICON_SM } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';

export interface ChipSelectOption extends ListboxOption {
  /** A second line under the label — the vendor's reason, a hostname, a hint. */
  readonly description?: string;
}

/** Which side of the chip the listbox opens on. */
type ChipSelectPlacement = 'above' | 'below';

export interface ChipSelectProps {
  readonly value: string;
  readonly options: readonly ChipSelectOption[];
  readonly onChange: (value: string) => void;
  /** The `key` half of the `key: value` chip. Omit for a value-only chip. */
  readonly label?: string;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
  /** Shown when `value` matches no option — a catalog that has not landed yet. */
  readonly placeholder?: string;
  readonly icon?: ReactNode;
  /** Rendered between the icon and the key, for a status dot and the like. */
  readonly adornment?: ReactNode;
  readonly title?: string;
  readonly describedBy?: string;
  readonly className?: string;
  readonly valueClassName?: string;
  readonly panelClassName?: string;
  /** `above` for a chip at the foot of the viewport (the composer), `below` near the top of it. */
  readonly placement?: ChipSelectPlacement;
  readonly testId?: string;
  readonly dataState?: string;
}

export function ChipSelect({
  value,
  options,
  onChange,
  label,
  ariaLabel,
  disabled = false,
  placeholder,
  icon,
  adornment,
  title,
  describedBy,
  className,
  valueClassName,
  panelClassName = 'w-56',
  placement = 'above',
  testId,
  dataState,
}: ChipSelectProps) {
  const listId = useId();
  const {
    open,
    activeIndex,
    setActiveIndex,
    containerRef,
    selected,
    toggle,
    commit,
    handleKeyDown,
  } = useListboxSelect({ value, options, onChange, disabled });
  const { popoverAbove, popoverBelow } = useMotionPresets();
  // The panel travels in from the side it opens on, so the two go together.
  const below = placement === 'below';

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are handled for the combobox trigger and the options it owns, both inside this wrapper.
    <div
      ref={containerRef}
      className="relative flex items-center"
      onKeyDown={handleKeyDown}
      data-testid={testId}
      data-state={dataState}
    >
      <button
        type="button"
        role="combobox"
        disabled={disabled}
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Focus stays on the trigger while arrowing, so the cursor has to be
        // announced rather than merely painted.
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        title={title}
        // The open state is styled off `aria-expanded` in `index.css`, so it
        // follows the composer's runner accent rather than the product primary.
        className={cn('composer-chip max-w-[13rem] disabled:opacity-50', className)}
      >
        {icon}
        {adornment}
        {label ? <span className="composer-chip-key text-fg-muted">{`${label}:`}</span> : null}
        <span className={cn('composer-chip-value', valueClassName)}>
          {selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown size={ICON_SM} className="shrink-0" />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            {...(below ? popoverBelow : popoverAbove)}
            className={cn(
              'dropdown-panel app-scrollbar absolute left-0 max-h-[50vh] overflow-y-auto p-1',
              below ? 'top-full mt-1' : 'bottom-full mb-2',
              panelClassName
            )}
          >
            <div id={listId} role="listbox" aria-label={ariaLabel}>
              {options.map((option, index) => {
                const isSelected = option.value === value;
                return (
                  <button
                    key={option.value}
                    id={`${listId}-${index}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    // Focus stays on the trigger and the cursor travels by
                    // `aria-activedescendant`, so the options must not also be
                    // their own tab stops.
                    tabIndex={-1}
                    disabled={option.disabled}
                    onClick={() => commit(option)}
                    onMouseEnter={() => setActiveIndex(index)}
                    className={cn(
                      'flex min-h-8 w-full items-start justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors',
                      'disabled:cursor-not-allowed disabled:opacity-50',
                      index === activeIndex && !option.disabled && 'bg-fill-hover',
                      isSelected && 'bg-fill-selected'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={cn('block truncate', isSelected ? 'font-medium' : '')}>
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="mt-0.5 block text-xs text-fg-muted">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <Check size={ICON_MD} className="mt-0.5 shrink-0 text-accent-fg" />
                    ) : null}
                  </button>
                );
              })}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
