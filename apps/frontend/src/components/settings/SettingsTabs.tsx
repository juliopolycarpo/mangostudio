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
    { to: '/settings/appearance' as const, label: t.settings.tabs.appearance },
  ];

  return (
    <nav
      className="flex gap-1 border-b border-outline-variant/20 pb-0"
      aria-label="Settings navigation"
    >
      {tabs.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          className="px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-all duration-200 text-on-surface-variant/60 hover:text-on-surface hover:bg-surface-container-high"
          activeProps={{
            className:
              'px-4 py-2.5 text-sm font-semibold rounded-t-lg transition-all duration-200 text-primary border-b-2 border-primary -mb-px bg-primary/5',
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
