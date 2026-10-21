import { cn } from '@/lib/utils';

interface PanelTab<T extends string> {
  readonly id: T;
  readonly label: string;
}

interface PanelTabsProps<T extends string> {
  readonly tabs: readonly PanelTab<T>[];
  readonly active: T;
  readonly onSelect: (id: T) => void;
  /** Names the strip for screen readers when the surrounding heading does not. */
  readonly label?: string;
}

const TAB_BASE =
  'relative inline-flex h-9 cursor-pointer items-center rounded-t-sm px-3 text-sm whitespace-nowrap transition-colors';
const TAB_IDLE = 'text-fg-muted hover:bg-fill-hover hover:text-fg';
const TAB_ACTIVE =
  'font-medium text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent';

/**
 * Underline tabs for switching a panel between two views held in state — the
 * same dialect as `TabNav`, which is for sibling routes and cannot be used
 * where a tab is not a URL.
 *
 * // Usage: <PanelTabs tabs={[{ id: 'changes', label }, …]} active={view} onSelect={setView} />
 */
export function PanelTabs<T extends string>({ tabs, active, onSelect, label }: PanelTabsProps<T>) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 border-b border-stroke">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onSelect(tab.id)}
          className={cn(TAB_BASE, active === tab.id ? TAB_ACTIVE : TAB_IDLE)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
