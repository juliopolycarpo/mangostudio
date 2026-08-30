import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { type SettingsNavGroup, settingsNavGroups } from './settings-nav';

// Router `Link` concatenates `className` with the matching state's className,
// so the three class strings must stay disjoint: an idle colour in the base
// would still be on the active link, fighting `text-primary` on stylesheet
// order alone.
const LINK_BASE =
  'block rounded-lg px-3 py-2 text-sm transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40';
const LINK_IDLE =
  'font-medium text-on-surface-variant/70 hover:bg-surface-container-high/60 hover:text-on-surface';
const LINK_ACTIVE = 'font-semibold text-primary bg-primary/12';

/**
 * The list's own surface, so the column reads as one object against the page
 * instead of fifteen links loose on the background.
 *
 * `surface-container-highest` at 60% and not `.glass-panel`: the glass fill is
 * *lighter* than the page in both themes, which lands a near-white panel on a
 * near-white background and leaves the light theme with no panel at all. This
 * token moves away from the background in whichever direction the theme has
 * room for, and composites to the same weight as the `Card` surface the
 * settings pages themselves use.
 *
 * The height cap is what makes `sticky` safe: a pinned column taller than the
 * scrollport can never show its last rows, because the page scrolls underneath
 * it. `7rem` is the header (~4.25rem) plus the `top-6` offset plus breathing
 * room at the bottom; erring high only means the panel scrolls itself slightly
 * sooner than it strictly must.
 */
const PANEL_SURFACE = 'bg-surface-container-highest/60 border border-outline-variant/20';
const PANEL_BASE = `app-scrollbar mt-2 space-y-5 rounded-2xl p-3 ${PANEL_SURFACE}`;
const PANEL_DESKTOP = 'lg:mt-0 lg:block lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto';

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
          'flex w-full items-center justify-between gap-2 rounded-2xl px-4 py-3 text-sm font-medium text-on-surface lg:hidden',
          PANEL_SURFACE
        )}
      >
        <span className="truncate">
          {currentSettingsLabel(groups, pathname) ?? t.settings.title}
        </span>
        <ChevronDown
          size={16}
          className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      <div id={listId} className={cn(PANEL_BASE, PANEL_DESKTOP, !open && 'hidden')}>
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            {/* Padding under the heading rather than a rule between groups:
                five sections in one panel separate on spacing alone, and four
                hairlines would read as a table. */}
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
 */
function currentSettingsLabel(
  groups: readonly SettingsNavGroup[],
  pathname: string
): string | undefined {
  return groups
    .flatMap((group) => group.entries)
    .filter((entry) => typeof entry.to === 'string' && pathname.startsWith(entry.to))
    .sort((a, b) => String(b.to).length - String(a.to).length)[0]?.label;
}
