import { Link, type LinkProps } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';

import { TAB_CLASSES, TabLabel } from './Tabs';

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
  /**
   * Lights the tab although the URL is not under its `to`: it is `aria-current`
   * and wears the active look all the same. For a page that belongs to a tab
   * without living under its path — a resource's own page, whose kind's tab is
   * the one that says where the person is. The router lights none of them there.
   */
  readonly current?: boolean;
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
 * The strip is one row that scrolls sideways when the tabs do not fit, as
 * `Tabs` does; the current tab is scrolled into view, so a deep link or a tap
 * on a half-visible tab never leaves the page you are on off-screen.
 *
 * Nesting is allowed: a section that owns a second level renders its own strip
 * below its parent's, and each one only lists its own siblings.
 */
export function TabNav({ tabs, label }: Props) {
  const listRef = useRef<HTMLDivElement>(null);

  // The router marks the current link `aria-current="page"` without rendering
  // this component again, so the attribute is what is watched — once now, for a
  // page opened on a tab that is out of view, and on every navigation after it.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const reveal = () =>
      list
        .querySelector('[aria-current="page"]')
        ?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    reveal();
    const observer = new MutationObserver(reveal);
    observer.observe(list, { attributes: true, attributeFilter: ['aria-current'], subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <nav className={TAB_CLASSES.strip} aria-label={label}>
      <div ref={listRef} className={TAB_CLASSES.list}>
        {tabs.map(({ to, label: tabLabel, exact = false, search, current = false }) => (
          <Link
            key={to}
            to={to}
            search={search}
            activeOptions={{ exact }}
            className={TAB_CLASSES.base}
            activeProps={{ className: TAB_CLASSES.active }}
            // A forced tab is one the router calls inactive, so it is dressed
            // through the inactive props: the router's own `aria-current` is only
            // added to the links it matched.
            inactiveProps={
              current
                ? { className: TAB_CLASSES.active, 'aria-current': 'page' }
                : { className: TAB_CLASSES.idle }
            }
          >
            <TabLabel>{tabLabel}</TabLabel>
          </Link>
        ))}
      </div>
    </nav>
  );
}
