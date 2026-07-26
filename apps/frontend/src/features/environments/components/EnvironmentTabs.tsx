/**
 * Sub-navigation for the environments surface, matching the settings tabs so
 * the two top-level areas behave the same way.
 */

import { Link } from '@tanstack/react-router';
import { useI18n } from '@/hooks/use-i18n';

export function EnvironmentTabs() {
  const { t } = useI18n();

  const tabs = [
    { to: '/environments/runtimes' as const, label: t.environments.tabs.runtimes },
    { to: '/environments/agents' as const, label: t.environments.tabs.agents },
    { to: '/environments/health' as const, label: t.environments.tabs.health },
  ];

  return (
    <nav
      className="flex flex-wrap gap-1 border-b border-outline-variant/20 pb-0 sm:gap-0.5"
      aria-label={t.environments.title}
    >
      {tabs.map(({ to, label }) => (
        <Link
          key={to}
          to={to}
          className="whitespace-nowrap rounded-t-lg px-3 py-2.5 text-sm font-medium text-on-surface-variant/60 transition-all duration-200 hover:bg-surface-container-high/60 hover:text-on-surface sm:px-4"
          activeProps={{
            className:
              '-mb-px whitespace-nowrap rounded-t-lg border-b-2 border-primary bg-primary/5 px-3 py-2.5 text-sm font-semibold text-primary transition-all duration-200 sm:px-4',
          }}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
