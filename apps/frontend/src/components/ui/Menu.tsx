import { Check } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useRef } from 'react';

/** Props the caller must spread onto whatever element opens the menu. */
interface MenuTriggerProps {
  readonly onClick: () => void;
  readonly 'aria-haspopup': 'menu';
  readonly 'aria-expanded': boolean;
}

interface MenuProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Rendered inside the positioning wrapper so the panel anchors to it. */
  readonly trigger: (props: MenuTriggerProps) => ReactNode;
  readonly align?: 'left' | 'right';
  readonly panelClassName?: string;
  readonly children: ReactNode;
}

const ITEM_SELECTOR = '[role="menuitem"]:not(:disabled), [role="menuitemcheckbox"]:not(:disabled)';

export function Menu({
  open,
  onOpenChange,
  trigger,
  align = 'right',
  panelClassName = 'w-56',
  children,
}: MenuProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        onOpenChange(false);
      }
    }
    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, onOpenChange]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.key === 'Escape') {
      // The menu may live inside a dialog that also closes on Escape; the
      // innermost layer is the one the user meant to dismiss.
      event.stopPropagation();
      onOpenChange(false);
      containerRef.current?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    const items = Array.from(
      containerRef.current?.querySelectorAll<HTMLElement>(ITEM_SELECTOR) ?? []
    );
    if (items.length === 0) return;
    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    // Arrowing from the trigger enters the list from whichever end it points at.
    const next =
      event.key === 'ArrowDown'
        ? (current + 1) % items.length
        : current <= 0
          ? items.length - 1
          : current - 1;
    items[next]?.focus();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: roving focus is delegated from the wrapper to the trigger and items it contains.
    <div ref={containerRef} className="relative" onKeyDown={handleKeyDown}>
      {trigger({
        onClick: () => onOpenChange(!open),
        'aria-haspopup': 'menu',
        'aria-expanded': open,
      })}
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.12, ease: 'easeOut' }}
            role="menu"
            className={`dropdown-panel absolute top-full mt-1.5 py-1 ${
              align === 'right' ? 'right-0' : 'left-0'
            } ${panelClassName}`}
          >
            {children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

interface MenuItemProps {
  readonly onSelect: () => void;
  readonly disabled?: boolean;
  readonly icon?: ReactNode;
  /** Renders the item as a checkable toggle that keeps the menu semantics. */
  readonly checked?: boolean;
  readonly tone?: 'default' | 'danger';
  readonly children: ReactNode;
}

export function MenuItem({
  onSelect,
  disabled = false,
  icon,
  checked,
  tone = 'default',
  children,
}: MenuItemProps) {
  // A checkable entry needs the checkbox role for `aria-checked` to be valid,
  // so the pair travels together instead of being set independently.
  const roleProps =
    checked === undefined
      ? ({ role: 'menuitem' } as const)
      : ({ role: 'menuitemcheckbox', 'aria-checked': checked } as const);

  return (
    <button
      type="button"
      {...roleProps}
      disabled={disabled}
      onClick={onSelect}
      className={`flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        tone === 'danger'
          ? 'text-error hover:bg-error/10'
          : 'text-on-surface hover:bg-primary/10 hover:text-primary'
      }`}
    >
      {icon ? (
        <span className="flex size-3.5 shrink-0 items-center justify-center">{icon}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked ? <Check size={13} className="shrink-0 text-primary" /> : null}
    </button>
  );
}

export function MenuSeparator() {
  return <hr className="my-1 h-px border-0 bg-outline-variant/20" />;
}
