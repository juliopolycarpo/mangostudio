/**
 * Sub-navigation for the library surface, matching the environments and
 * settings tabs so the top-level areas all behave the same way.
 */

import { Link } from '@tanstack/react-router';
import { useI18n } from '@/hooks/use-i18n';

export function LibraryTabs() {
  const { t } = useI18n();

  const tabs = [
    { to: '/library/skills' as const, label: t.library.tabs.skills },
    { to: '/library/subagents' as const, label: t.library.tabs.subagents },
    { to: '/library/instructions' as const, label: t.library.tabs.instructions },
    { to: '/library/settings' as const, label: t.library.tabs.settings },
  ];

  return (
    <nav
      className="flex flex-wrap gap-1 border-outline-variant/20 border-b pb-0 sm:gap-0.5"
      aria-label={t.library.title}
    >
      {tabs.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          className="whitespace-nowrap rounded-t-lg px-3 py-2.5 font-medium text-on-surface-variant/60 text-sm transition-all duration-200 hover:bg-surface-container-high/60 hover:text-on-surface sm:px-4"
          activeProps={{
            className:
              '-mb-px whitespace-nowrap rounded-t-lg border-primary border-b-2 bg-primary/5 px-3 py-2.5 font-semibold text-primary text-sm transition-all duration-200 sm:px-4',
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
