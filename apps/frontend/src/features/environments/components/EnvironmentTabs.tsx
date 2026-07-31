/**
 * Top-level navigation for the environments umbrella: everything about the
 * user's tooling, library included. The library tab opens a section that
 * renders a second strip of its own.
 */

import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';

export function EnvironmentTabs() {
  const { t } = useI18n();

  return (
    <TabNav
      label={t.environments.title}
      tabs={[
        // The umbrella root is every other tab's prefix, so this one only lights
        // on the overview itself.
        { to: '/environments', label: t.environments.tabs.overview, exact: true },
        { to: '/environments/runtimes', label: t.environments.tabs.runtimes },
        { to: '/environments/agents', label: t.environments.tabs.agents },
        { to: '/environments/health', label: t.environments.tabs.health },
        { to: '/environments/library', label: t.environments.tabs.library },
      ]}
    />
  );
}
