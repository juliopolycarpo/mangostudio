import { ChevronDown, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { ICON_SM } from '@/lib/icon-sizes';

interface GithubSectionProps {
  readonly label: string;
  readonly testId: string;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Refresh and staleness — header furniture that belongs to the section. */
  readonly action?: ReactNode;
  readonly children: ReactNode;
}

/**
 * A collapsible group inside the rail.
 *
 * `MicroLabel` grouping rather than `SectionCard`: the card shell is the home
 * hub's, and nesting bordered cards inside a 360px rail that already has its
 * own chrome stacks three borders around a list of six rows.
 *
 * A real `<button>` with `aria-expanded` rather than `<details>`/`<summary>`,
 * because the collapsed state is persisted and driven from props — a `details`
 * element owns its own openness and fights a controlled value.
 *
 * @example
 * <GithubSection label="Waiting on you" testId="github-inbox-section" collapsed={false} onToggle={toggle}>
 */
export function GithubSection({
  label,
  testId,
  collapsed,
  onToggle,
  action,
  children,
}: GithubSectionProps) {
  const Chevron = collapsed ? ChevronRight : ChevronDown;

  return (
    <section data-testid={testId} className="min-w-0">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded text-left text-on-surface-variant transition-colors hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary"
        >
          <Chevron size={ICON_SM} className="shrink-0" aria-hidden="true" />
          <MicroLabel as="h3" className="min-w-0 truncate">
            {label}
          </MicroLabel>
        </button>
        {action}
      </div>
      {collapsed ? null : <div className="px-3 pb-3">{children}</div>}
    </section>
  );
}
