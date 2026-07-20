import { Link } from '@tanstack/react-router';
import { useI18n } from '@/hooks/use-i18n';

/**
 * Horizontal tab navigation for the Settings page.
 * Each tab is a TanStack Router Link for bookmarkable URLs.
 */
export function SettingsTabs() {
  const { t } = useI18n();

  const tabs = [
    { to: '/settings/general' as const, label: t.settings.tabs.general },
    { to: '/settings/connectors' as const, label: t.settings.tabs.connectors },
    { to: '/settings/providers' as const, label: t.settings.tabs.providers },
    { to: '/settings/agents' as const, label: t.settings.tabs.agents },
    { to: '/settings/prompts' as const, label: t.settings.tabs.prompts },
    { to: '/settings/appearance' as const, label: t.settings.tabs.appearance },
    { to: '/settings/context' as const, label: t.settings.tabs.context },
    { to: '/settings/git' as const, label: t.settings.tabs.git },
    { to: '/settings/tools' as const, label: t.settings.tabs.tools },
    { to: '/settings/skills' as const, label: t.settings.tabs.skills },
    { to: '/settings/mcp' as const, label: t.settings.tabs.mcp },
    { to: '/settings/metrics' as const, label: t.settings.tabs.metrics },
    { to: '/settings/logs' as const, label: t.settings.tabs.logs },
  ];

  return (
    <nav
      className="flex flex-wrap gap-1 sm:gap-0.5 border-b border-outline-variant/20 pb-0"
      aria-label={t.common.settingsNavigation}
    >
      {tabs.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          className="px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg transition-all duration-200 text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high/60 whitespace-nowrap"
          activeProps={{
            className:
              'px-3 sm:px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-all duration-200 text-primary border-b-2 border-primary -mb-px bg-primary/5 whitespace-nowrap',
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
