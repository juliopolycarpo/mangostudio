/**
 * The app's form dropdown.
 *
 * Eighteen settings fields were a native `<select>` with the box styled and
 * the list left alone. Styling the box is the half that does not matter: the
 * popup an `<option>` list opens is drawn by the platform — square corners,
 * system font, system highlight, its own colour scheme — landing an OS widget
 * in the middle of a page whose every other menu is a `dropdown-panel`.
 * `option` is not styleable to that degree in any engine we ship to, which is
 * the same wall `ChipSelect` hit on the composer strip.
 *
 * This is that control in the form dialect rather than a second copy of it:
 * the keyboard and open/close behaviour comes from `useListboxSelect`, and
 * only the markup differs — full width, `Input`'s tokens and radius, and a
 * panel that opens downward, because a settings field sits in the middle of a
 * page rather than at the foot of the viewport.
 *
 * It keeps `role="combobox"` and stays labelable, so `getByRole('combobox',
 * { name })` and a `<label htmlFor>` both still address it.
 *
 * Usage: <Select id="language" value={locale} options={locales} onChange={setLocale} />
 */

import { Check, ChevronDown } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAnchoredPosition } from '@/hooks/use-anchored-position';
import { type ListboxOption, useListboxSelect } from '@/hooks/use-listbox-select';
import { cn } from '@/lib/utils';

export interface SelectOption extends ListboxOption {
  readonly label: string;
  /** A second line under the label — a model's provider, a hint, a warning. */
  readonly description?: string;
}

interface SelectProps {
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  /** Ties an external `<label htmlFor>` to the trigger, as a native select would. */
  readonly id?: string;
  readonly ariaLabel?: string;
  readonly disabled?: boolean;
  /** Shown when `value` matches no option — a model the catalog no longer lists. */
  readonly placeholder?: string;
  readonly className?: string;
  readonly testId?: string;
}

const TRIGGER =
  'flex w-full items-center justify-between gap-2 rounded-xl px-4 py-2.5 text-sm text-left bg-surface-container-lowest text-on-surface border border-outline-variant/20 transition-colors cursor-pointer hover:border-outline-variant/40 focus:outline-none focus:border-primary/60 focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:border-primary/60';

/** The `max-h-[16rem]` the panel used to carry, now a number the anchor needs. */
const PANEL_MAX_HEIGHT = 256;

export function Select({
  value,
  options,
  onChange,
  id,
  ariaLabel,
  disabled = false,
  placeholder,
  className,
  testId,
}: SelectProps) {
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const {
    open,
    setOpen,
    activeIndex,
    setActiveIndex,
    containerRef,
    panelRef,
    selected,
    commit,
    handleKeyDown,
  } = useListboxSelect({ value, options, onChange, disabled });
  const position = useAnchoredPosition(triggerRef, open, PANEL_MAX_HEIGHT);

  // Focus never leaves the trigger, so nothing scrolls the panel on its own:
  // past the sixth row of a capped list the cursor moves and the page does
  // not, which is the one thing the native popup always got right. `nearest`
  // is a no-op for a row already in view, so hovering does not yank the list.
  // `useId` values contain characters a CSS selector cannot carry, hence
  // `getElementById` rather than `querySelector`.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [open, activeIndex, listId]);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the keys are handled for the combobox trigger and the options it owns, both inside this wrapper.
    <div
      ref={containerRef}
      className={cn('relative', className)}
      onKeyDown={handleKeyDown}
      data-testid={testId}
    >
      <button
        ref={triggerRef}
        type="button"
        id={id}
        role="combobox"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Focus stays on the trigger while arrowing, so the cursor has to be
        // announced rather than merely painted.
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        className={TRIGGER}
      >
        <span className={cn('truncate', !selected && 'text-on-surface-variant/60')}>
          {selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown
          size={16}
          className={cn(
            'shrink-0 text-on-surface-variant transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && position ? (
            <motion.div
              ref={panelRef}
              initial={{ opacity: 0, y: -6, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.98 }}
              transition={{ duration: 0.15, ease: 'easeOut' }}
              // Placed by hand in `document.body` rather than `absolute` in the
              // wrapper: these sit inside dialogs and panes that scroll, and an
              // absolute panel is clipped by them — which is the one thing the
              // platform popup this replaced never suffered from. Stacked above
              // the dialog (`z-50`) and palette (`z-[60]`) layers it opens over.
              style={{
                position: 'fixed',
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              className="app-scrollbar dropdown-panel z-[70] overflow-y-auto py-1"
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
                        'flex w-full items-start justify-between gap-2 px-4 py-2 text-left text-sm transition-colors',
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
                          <span className="mt-0.5 block text-xs leading-relaxed text-on-surface-variant/80">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                      {isSelected ? (
                        <Check size={14} className="mt-0.5 shrink-0 text-primary" />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
