import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { FIELD_CLASS } from '@/components/ui/Input';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { SELECTION_BAR } from '@/components/ui/selection-bar';
import { useI18n } from '@/hooks/use-i18n';
import { ICON_MD } from '@/lib/icon-sizes';
import { cn } from '@/lib/utils';
import { type SettingsNavGroup, settingsNavGroups } from './settings-nav';

// Router `Link` concatenates `className` with the matching state's className,
// so the three class strings must stay disjoint: an idle colour in the base
// would still be on the active link, fighting `text-fg` on stylesheet order
// alone.
const LINK_BASE = 'relative flex h-8 items-center rounded-sm px-3 text-sm transition-colors';
const LINK_IDLE = 'text-fg-muted hover:bg-fill-hover hover:text-fg';
// The current page is a neutral fill plus the accent bar, as in the app sidebar.
const LINK_ACTIVE = `bg-fill-selected font-medium text-fg ${SELECTION_BAR}`;

/**
 * Below `lg` the list is a panel under the toggle; from `lg` it is bare, on the
 * page's own canvas beside the content.
 *
 * The height cap is what makes `sticky` safe: a pinned column taller than the
 * scrollport can never show its last rows, because the page scrolls underneath
 * it. `6rem` is the `top-6` offset plus the same again at the foot; erring high
 * only means the list scrolls itself slightly sooner than it strictly must.
 */
const LIST_BASE =
  'app-scrollbar max-lg:mt-2 max-lg:rounded-md max-lg:border max-lg:border-stroke max-lg:bg-surface max-lg:p-2';
const LIST_DESKTOP = 'lg:block lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto';

/**
 * Navigation for the settings surface: fifteen pages under five headings.
 *
 * One list in the DOM, not one per breakpoint. A desktop copy plus a mobile
 * copy would put every settings link on the page twice — two tab stops per
 * page for a keyboard, and two hits for anything asking the document for a
 * link by name.
 *
 * The list is a column beside the content from `lg` up, where there is room
 * for it. Below that it collapses behind the page it is currently on, because
 * a twenty-row list above every settings page is a scroll the user pays on
 * each visit.
 */
export function SettingsNav() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const groups = settingsNavGroups(t.settings);
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  // Closing on the links' own `onClick` is not enough: this nav is mounted by
  // the settings layout and only the page under it is swapped, so the command
  // palette and the back button both change what is on screen without going
  // through a link here. Left open, the list that exists to stay out of the way
  // is sitting on top of the page you just reached.
  useEffect(() => setOpen(false), [pathname]);

  return (
    <nav aria-label={t.common.settingsNavigation} className="lg:sticky lg:top-6 lg:self-start">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={listId}
        className={cn(
          FIELD_CLASS,
          'flex cursor-pointer items-center justify-between gap-2 text-left font-medium lg:hidden'
        )}
      >
        <span className="truncate">
          {currentSettingsLabel(groups, pathname) ?? t.settings.title}
        </span>
        <ChevronDown size={ICON_MD} className="shrink-0 text-fg-muted" />
      </button>

      <div id={listId} className={cn(LIST_BASE, LIST_DESKTOP, 'space-y-5', !open && 'hidden')}>
        {groups.map((group) => (
          <div key={group.id} className="space-y-0.5">
            <MicroLabel as="h2" className="px-3 pb-1">
              {group.label}
            </MicroLabel>
            {/* No `activeOptions.exact`: the providers page owns a `$provider`
                child, and an exact match would unlight its own entry the
                moment you open one of them. No settings path is the prefix of
                another, so prefix matching costs nothing here. */}
            {group.entries.map((entry) => (
              <Link
                key={entry.to}
                to={entry.to}
                onClick={() => setOpen(false)}
                className={LINK_BASE}
                activeProps={{ className: LINK_ACTIVE }}
                inactiveProps={{ className: LINK_IDLE }}
              >
                {entry.label}
              </Link>
            ))}
          </div>
        ))}
      </div>
    </nav>
  );
}

/**
 * The page the collapsed nav is standing in for. Longest matching path wins,
 * so `/settings/providers/openai` reports Providers rather than nothing.
 *
 * The match is on whole segments: a bare `startsWith` would let a future
 * `/settings/git-hub` be reported as Git, which is the kind of wrong that
 * looks right.
 */
function currentSettingsLabel(
  groups: readonly SettingsNavGroup[],
  pathname: string
): string | undefined {
  return groups
    .flatMap((group) => group.entries)
    .filter((entry) => typeof entry.to === 'string' && isUnderPath(pathname, entry.to))
    .sort((a, b) => String(b.to).length - String(a.to).length)[0]?.label;
}

/** True when `pathname` is `base` or one of its descendants. */
function isUnderPath(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}
