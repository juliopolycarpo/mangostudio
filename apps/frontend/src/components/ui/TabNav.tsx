import { Link, type LinkProps } from '@tanstack/react-router';

// Router Link concatenates `className` with the matching state's className, so
// the two state classes must stay disjoint from the base and from each other:
// putting the idle color in the base would leave `text-fg-muted`
// on the active tab, fighting `text-accent-fg` on stylesheet order alone.
/** Underline tabs: the 2px accent rule is the only mark of the current one. */
const TAB_LINK_BASE =
  'relative h-9 inline-flex items-center rounded-t-sm px-3 text-sm transition-colors whitespace-nowrap';
const TAB_LINK_IDLE = 'text-fg-muted hover:bg-fill-hover hover:text-fg';
const TAB_LINK_ACTIVE =
  'font-medium text-fg after:absolute after:inset-x-3 after:-bottom-px after:h-0.5 after:rounded-full after:bg-accent';

interface Tab {
  readonly to: LinkProps['to'];
  readonly label: string;
  readonly search?: LinkProps['search'];
  /**
   * Lights only on its own URL. A tab whose path is the prefix of its siblings
   * — a surface root next to the pages under it — stays lit on every one of
   * them without this, which is the opposite of what a tab strip is for.
   */
  readonly exact?: boolean;
}

interface Props {
  readonly tabs: readonly Tab[];
  /** Names the strip for screen readers — usually the surface it navigates. */
  readonly label: string;
}

/**
 * Horizontal tab strip for a top-level surface, one bookmarkable URL per tab.
 *
 * Nesting is allowed: a section that owns a second level renders its own strip
 * below its parent's, and each one only lists its own siblings.
 */
export function TabNav({ tabs, label }: Props) {
  return (
    <nav className="flex flex-wrap gap-1 border-b border-stroke" aria-label={label}>
      {tabs.map(({ to, label: tabLabel, exact = false, search }) => (
        <Link
          key={to}
          to={to}
          search={search}
          activeOptions={{ exact }}
          className={TAB_LINK_BASE}
          activeProps={{ className: TAB_LINK_ACTIVE }}
          inactiveProps={{ className: TAB_LINK_IDLE }}
        >
          {tabLabel}
        </Link>
      ))}
    </nav>
  );
}
