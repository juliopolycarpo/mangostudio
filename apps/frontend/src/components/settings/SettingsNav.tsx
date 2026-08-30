import { Link, useRouterState } from '@tanstack/react-router';
import { ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { MicroLabel } from '@/components/ui/MicroLabel';
import { useI18n } from '@/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { type SettingsNavGroup, settingsNavGroups } from './settings-nav';

// Router `Link` concatenates `className` with the matching state's className,
// so the three class strings must stay disjoint: an idle colour in the base
// would still be on the active link, fighting `text-primary` on stylesheet
// order alone.
const LINK_BASE = 'block rounded-lg px-3 py-2 text-sm transition-colors duration-200';
const LINK_IDLE = 'font-medium text-on-surface-variant/70 hover:bg-surface-container-high/60';
const LINK_ACTIVE = 'font-semibold text-primary bg-primary/8';

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
  const currentLabel = useCurrentSettingsLabel(groups);

  return (
    <nav aria-label={t.common.settingsNavigation} className="lg:sticky lg:top-0 lg:self-start">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-controls={listId}
        className="flex w-full items-center justify-between gap-2 rounded-xl border border-outline-variant/20 bg-surface-container-low/60 px-4 py-3 text-sm font-medium text-on-surface lg:hidden"
      >
        <span className="truncate">{currentLabel}</span>
        <ChevronDown
          size={16}
          className={cn('shrink-0 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      <div id={listId} className={cn('space-y-4 pt-2 lg:block lg:pt-0', !open && 'hidden')}>
        {groups.map((group) => (
          <div key={group.id} className="space-y-1">
            <MicroLabel as="h2" className="px-3">
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
function useCurrentSettingsLabel(groups: readonly SettingsNavGroup[]): string {
  const { t } = useI18n();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const match = groups
    .flatMap((group) => group.entries)
    .filter((entry) => typeof entry.to === 'string' && pathname.startsWith(entry.to))
    .sort((a, b) => String(b.to).length - String(a.to).length)[0];
  return match?.label ?? t.settings.title;
}
