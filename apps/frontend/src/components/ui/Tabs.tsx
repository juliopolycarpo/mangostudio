import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * The underline-tab look, written once for both strips: `TabNav` draws it on
 * router links, `Tabs` on buttons, and neither can drift from the other.
 *
 * `base`, `idle` and `active` stay disjoint on purpose. Router `Link` concatenates
 * `className` with the matching state's class, so an idle colour in the base would
 * leave `text-fg-muted` on the current tab, fighting `text-fg` on stylesheet order
 * alone. The 2px accent rule is the only mark of the current tab; it sits on the
 * strip's divider.
 */
export const TAB_CLASSES = {
  strip: 'flex gap-1 border-b border-stroke',
  base: 'relative inline-flex h-9 shrink-0 cursor-pointer items-center rounded-t-sm px-3 text-sm whitespace-nowrap transition-colors',
  idle: 'text-fg-muted hover:bg-fill-hover hover:text-fg',
  active:
    'font-medium text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent',
} as const;

export interface TabItem<T extends string> {
  readonly id: T;
  readonly label: string;
  /** Tooltip, for a label the strip truncates. */
  readonly title?: string;
  /** Names the tab for tests that find it by id; lands on the tab's outermost element. */
  readonly testId?: string;
  /**
   * Buttons that live inside the tab, after its label: close, rename. The tab is
   * a Tailwind `group`, so an action can reveal itself with `group-hover:`.
   */
  readonly actions?: ReactNode;
  /** Replaces the label while set, for a tab renamed in place. The arrow keys skip it. */
  readonly editor?: ReactNode;
  /** Fires on a double click of the label. */
  readonly onDoubleClick?: () => void;
}

interface TabsProps<T extends string> {
  readonly tabs: readonly TabItem<T>[];
  /** The selected tab; `null` when none is, as a strip of sessions is before one opens. */
  readonly active: T | null;
  readonly onSelect: (id: T) => void;
  /** Names the strip for screen readers when the surrounding heading does not. */
  readonly label?: string;
  /** Sits after the tabs, outside the tablist: the button that adds one. */
  readonly trailing?: ReactNode;
  readonly className?: string;
}

/** The tab an arrow or Home/End key moves to, wrapping at the ends; `null` for any other key. */
function targetIndex(key: string, from: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
      return (from + 1) % count;
    case 'ArrowLeft':
      return (from - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/**
 * Underline tabs for views held in state — the same look as `TabNav`, which is
 * for sibling routes and cannot be used where a tab is not a URL.
 *
 * The strip is one tab stop (the selected tab); Arrow, Home and End move
 * between tabs and select as they go. It scrolls sideways rather than wrapping.
 *
 * @example
 * <Tabs tabs={[{ id: 'changes', label }, …]} active={view} onSelect={setView} label={heading} />
 */
export function Tabs<T extends string>({
  tabs,
  active,
  onSelect,
  label,
  trailing,
  className,
}: TabsProps<T>) {
  const buttons = useRef(new Map<T, HTMLButtonElement>());
  // A tab being renamed has no button to land on, so keys and the tab stop pass it by.
  const reachable = tabs.filter((tab) => tab.editor === undefined);
  const tabStop = reachable.some((tab) => tab.id === active) ? active : reachable[0]?.id;

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const from = reachable.findIndex((tab) => buttons.current.get(tab.id) === event.target);
    if (from < 0) return;
    const to = targetIndex(event.key, from, reachable.length);
    const next = to === null ? undefined : reachable[to];
    if (!next) return;
    event.preventDefault();
    buttons.current.get(next.id)?.focus();
    if (next.id !== active) onSelect(next.id);
  }

  return (
    <div className={cn(TAB_CLASSES.strip, 'items-center', className)}>
      {/* The list scrolls, and scrolling clips what is drawn below the tabs, so it
          reaches one pixel over the divider (`-mb-px`) and pads one pixel back
          (`pb-px`) to keep the current tab's rule on the divider without clipping it. */}
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={handleKeyDown}
        className="-mb-px flex min-w-0 gap-1 overflow-x-auto pb-px"
      >
        {tabs.map((tab) => {
          const selected = tab.id === active;
          const chrome = cn(TAB_CLASSES.base, selected ? TAB_CLASSES.active : TAB_CLASSES.idle);
          const hasChrome = tab.actions !== undefined || tab.editor !== undefined;
          const button = (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              tabIndex={tab.id === tabStop ? 0 : -1}
              ref={(node) => {
                if (node) buttons.current.set(tab.id, node);
                else buttons.current.delete(tab.id);
              }}
              title={tab.title}
              onClick={() => onSelect(tab.id)}
              onDoubleClick={tab.onDoubleClick}
              data-testid={hasChrome ? undefined : tab.testId}
              className={
                hasChrome
                  ? 'max-w-32 truncate'
                  : // The tab is the whole button, so a ring offset outwards would be clipped by the scrolling list.
                    cn(chrome, '-outline-offset-2')
              }
            >
              {tab.label}
            </button>
          );
          if (!hasChrome) return button;
          return (
            <div key={tab.id} data-testid={tab.testId} className={cn(chrome, 'group gap-1')}>
              {tab.editor ?? button}
              {tab.actions}
            </div>
          );
        })}
      </div>
      {trailing}
    </div>
  );
}
