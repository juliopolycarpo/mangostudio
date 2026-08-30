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
 * is the same reason `ModelSelector` and `ThinkingToggle` do.
 */

import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { type ReactNode, useId } from 'react';
import { type ListboxOption, useListboxSelect } from '@/hooks/use-listbox-select';
import { cn } from '@/lib/utils';

export interface ChipSelectOption extends ListboxOption {
  /** A second line under the label — the vendor's reason, a hostname, a hint. */
  readonly description?: string;
}

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
        className={cn('composer-chip max-w-[13rem] disabled:opacity-60', className)}
      >
        {icon}
        {adornment}
        {label ? (
          <span className="composer-chip-key text-on-surface-variant/70">{`${label}:`}</span>
        ) : null}
        <span className={cn('composer-chip-value', valueClassName)}>
          {selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown
          size={11}
          className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.95 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className={cn(
              // Always opens upward: every chip sits on the composer's status
              // strip at the foot of the viewport.
              'dropdown-panel absolute left-0 bottom-full mb-2 max-h-[50vh] overflow-y-auto hide-scrollbar py-1',
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
                      'flex w-full items-start justify-between gap-2 px-3 py-2 text-left text-xs transition-colors',
                      'disabled:cursor-not-allowed disabled:opacity-40',
                      index === activeIndex && !option.disabled && 'bg-primary/10',
                      isSelected && 'bg-primary/5'
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate',
                          isSelected ? 'font-medium text-primary' : 'text-on-surface'
                        )}
                      >
                        {option.label}
                      </span>
                      {option.description ? (
                        <span className="mt-0.5 block text-[10px] leading-relaxed text-on-surface-variant/80">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                    {isSelected ? (
                      <Check size={13} className="mt-0.5 shrink-0 text-primary" />
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
