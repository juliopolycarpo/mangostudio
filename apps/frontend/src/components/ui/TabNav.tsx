import { Link, type LinkProps } from '@tanstack/react-router';
import { cn } from '@/lib/utils';
import { TAB_CLASSES } from './Tabs';

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
 * Tabs that are state rather than a URL use `Tabs`, which draws the same look.
 *
 * Nesting is allowed: a section that owns a second level renders its own strip
 * below its parent's, and each one only lists its own siblings.
 */
export function TabNav({ tabs, label }: Props) {
  return (
    <nav className={cn(TAB_CLASSES.strip, 'flex-wrap')} aria-label={label}>
      {tabs.map(({ to, label: tabLabel, exact = false, search }) => (
        <Link
          key={to}
          to={to}
          search={search}
          activeOptions={{ exact }}
          className={TAB_CLASSES.base}
          activeProps={{ className: TAB_CLASSES.active }}
          inactiveProps={{ className: TAB_CLASSES.idle }}
        >
          {tabLabel}
        </Link>
      ))}
    </nav>
  );
}
