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
import { ICON_MD } from '@/lib/icon-sizes';
import { useMotionPresets } from '@/lib/motion/use-motion-presets';
import { cn } from '@/lib/utils';

export interface SelectOption extends ListboxOption {
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
  'flex h-8 w-full items-center justify-between gap-2 rounded-sm border border-stroke border-b-stroke-strong bg-control pl-3 pr-2 text-sm text-left text-fg transition-colors cursor-pointer hover:bg-control-hover focus:outline-none focus:border-focus focus:ring-1 focus:ring-focus disabled:cursor-not-allowed disabled:opacity-50 aria-expanded:border-focus aria-expanded:border-b-focus aria-expanded:ring-1 aria-expanded:ring-focus';

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
  const { popoverBelow } = useMotionPresets();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const {
    open,
    activeIndex,
    setActiveIndex,
    containerRef,
    panelRef,
    selected,
    toggle,
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
        onClick={toggle}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        // Focus stays on the trigger while arrowing, so the cursor has to be
        // announced rather than merely painted.
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
        aria-label={ariaLabel}
        className={TRIGGER}
      >
        <span className={cn('truncate', !selected && 'text-fg-muted')}>
          {selected?.label ?? placeholder ?? value}
        </span>
        <ChevronDown size={ICON_MD} className="shrink-0 text-fg-muted" />
      </button>

      {createPortal(
        <AnimatePresence>
          {open && position ? (
            <motion.div
              ref={panelRef}
              {...popoverBelow}
              // Placed by hand in `document.body` rather than `absolute` in the
              // wrapper: these sit inside dialogs and panes that scroll, and an
              // absolute panel is clipped by them — which is the one thing the
              // platform popup this replaced never suffered from. The stacking
              // comes from `.dropdown-panel` (`z-index: 100`, unlayered, so it
              // beats any utility set here), which already clears the dialog
              // and palette layers this opens over.
              style={{
                position: 'fixed',
                top: position.top,
                left: position.left,
                width: position.width,
                maxHeight: position.maxHeight,
              }}
              className="app-scrollbar dropdown-panel overflow-y-auto p-1"
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
                        'disabled:cursor-not-allowed disabled:opacity-40',
                        index === activeIndex && !option.disabled && 'bg-fill-hover',
                        isSelected && 'bg-fill-selected'
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block truncate',
                            isSelected ? 'font-medium text-fg' : 'text-fg'
                          )}
                        >
                          {option.label}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-fg-muted">
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
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}
