/**
 * Top-level navigation for the environments surface.
 */

import { TabNav } from '@/components/ui/TabNav';
import { useI18n } from '@/hooks/use-i18n';

export function EnvironmentTabs() {
  const { t } = useI18n();

  return (
    <TabNav
      label={t.environments.title}
      tabs={[
        { to: '/environments/runtimes', label: t.environments.tabs.runtimes },
        { to: '/environments/agents', label: t.environments.tabs.agents },
        { to: '/environments/health', label: t.environments.tabs.health },
      ]}
    />
  );
}
